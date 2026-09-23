import { and, arrayContains, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { displayId } from '@ocso/domain';
import { channels, conversations, customerIdentities, customers, handoffs, queues, users, virtualAgents, type Db } from '@ocso/db';
import { z } from 'zod';
import { conversationScope, type VisibilityPolicy } from './access.js';
import { maskIdentity } from './masking.js';
import { TagSchema } from './tags.js';

export const INBOX_VIEWS = ['all', 'mine', 'waiting', 'ai', 'human', 'priority', 'resolved'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const InboxQuery = z.object({
  view: z.enum(INBOX_VIEWS).default('all'),
  agentId: z.uuid().optional(),
  queueId: z.uuid().optional(),
  search: z.string().trim().max(200).optional(),
  /** Only conversations carrying this tag (normalized like stored tags; GIN index conversations_tags_idx). */
  tag: TagSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});
export type InboxQuery = z.infer<typeof InboxQuery>;

export interface ConversationSummary {
  id: string;
  displayId: string;
  customer: { id: string; name: string | null; identity: string | null };
  channel: { id: string | null; kind: string | null; name: string | null };
  agent: { id: string; name: string; conversationType: string };
  controlState: string;
  priority: string;
  assignedUser: { id: string; name: string } | null;
  queue: { id: string; name: string } | null;
  lastPreview: string | null;
  lastInteractionAt: string;
  waitingSince: string | null;
  slaDueAt: string | null;
  /** Resolution SLA deadline (queue policy × conversation type); null when none applies. */
  resolutionDueAt: string | null;
  tags: string[];
  /** The open handoff (why a human is needed, how it is routed), if any. */
  handoff: { reason: string; mode: string; status: string } | null;
  resolvedAt: string | null;
  disposition: string | null;
  csat: number | null;
}

interface OpenHandoffJson {
  reason: string;
  mode: string;
  status: string;
}

function viewPredicate(view: InboxView, principal: Principal): SQL | undefined {
  const open = ne(conversations.controlState, 'RESOLVED');
  switch (view) {
    case 'all':
      return open;
    case 'mine':
      return and(open, eq(conversations.assignedUserId, principal.userId));
    case 'waiting':
      return inArray(conversations.controlState, ['WAITING_FOR_HUMAN', 'ESCALATION_REQUESTED']);
    case 'ai':
      return inArray(conversations.controlState, ['AI_ACTIVE', 'AI_RESUMING']);
    case 'human':
      return eq(conversations.controlState, 'HUMAN_ACTIVE');
    case 'priority':
      return and(open, inArray(conversations.priority, ['P1', 'P2']));
    case 'resolved':
      return eq(conversations.controlState, 'RESOLVED');
  }
}

/** Role-scoped conversation lists for the CS workspace (design/01 inbox). */
export class InboxService {
  constructor(private readonly db: Db) {}

  async list(principal: Principal, policy: VisibilityPolicy, q: InboxQuery): Promise<{ items: ConversationSummary[]; counts: Record<InboxView, number> }> {
    const scope = conversationScope(principal, policy);
    const filters = [
      scope ?? undefined,
      q.agentId ? eq(conversations.agentId, q.agentId) : undefined,
      q.queueId ? eq(conversations.queueId, q.queueId) : undefined,
      q.tag ? arrayContains(conversations.tags, [q.tag]) : undefined,
    ].filter(Boolean) as SQL[];
    const searchFilter = q.search ? this.searchPredicate(q.search) : undefined;
    const beforeFilter = q.before ? sql`${conversations.lastInteractionAt} < ${new Date(q.before)}` : undefined;
    const where = and(...filters, viewPredicate(q.view, principal), searchFilter, beforeFilter);

    const rows = await this.db
      .select({
        c: conversations,
        customerName: customers.displayName,
        channelKind: channels.kind,
        channelName: channels.name,
        agentName: virtualAgents.name,
        agentType: virtualAgents.conversationType,
        assigneeName: users.name,
        queueName: queues.name,
        identity: sql<string | null>`(SELECT ${customerIdentities.kind} || ':' || ${customerIdentities.value} FROM ${customerIdentities} WHERE ${customerIdentities.customerId} = ${conversations.customerId} ORDER BY ${customerIdentities.lastSeenAt} DESC LIMIT 1)`,
        handoff: sql<OpenHandoffJson | null>`(SELECT json_build_object('reason', ${handoffs.reasonText}, 'mode', ${handoffs.mode}, 'status', ${handoffs.status}) FROM ${handoffs} WHERE ${handoffs.conversationId} = ${conversations.id} AND ${handoffs.resolvedAt} IS NULL AND ${handoffs.cancelledAt} IS NULL AND ${handoffs.returnedAt} IS NULL ORDER BY ${handoffs.requestedAt} DESC LIMIT 1)`,
      })
      .from(conversations)
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .innerJoin(virtualAgents, eq(virtualAgents.id, conversations.agentId))
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .leftJoin(users, eq(users.id, conversations.assignedUserId))
      .leftJoin(queues, eq(queues.id, conversations.queueId))
      .where(where)
      .orderBy(q.view === 'resolved' ? desc(conversations.resolvedAt) : desc(conversations.lastInteractionAt))
      .limit(q.limit);

    const counts = await this.counts(principal, and(...filters));
    return {
      items: rows.map((r) => ({
        id: r.c.id,
        displayId: displayId('conv', r.c.id),
        customer: { id: r.c.customerId, name: r.customerName, identity: maskIdentity(r.identity) },
        channel: { id: r.c.channelId, kind: r.channelKind, name: r.channelName },
        agent: { id: r.c.agentId, name: r.agentName, conversationType: r.agentType },
        controlState: r.c.controlState,
        priority: r.c.priority,
        assignedUser: r.c.assignedUserId && r.assigneeName ? { id: r.c.assignedUserId, name: r.assigneeName } : null,
        queue: r.c.queueId && r.queueName ? { id: r.c.queueId, name: r.queueName } : null,
        lastPreview: r.c.lastPreview,
        lastInteractionAt: r.c.lastInteractionAt.toISOString(),
        waitingSince: r.c.waitingSince?.toISOString() ?? null,
        slaDueAt: r.c.slaDueAt?.toISOString() ?? null,
        resolutionDueAt: r.c.resolutionDueAt?.toISOString() ?? null,
        tags: r.c.tags,
        handoff: r.handoff ? { reason: r.handoff.reason, mode: r.handoff.mode, status: r.handoff.status } : null,
        resolvedAt: r.c.resolvedAt?.toISOString() ?? null,
        disposition: r.c.disposition,
        csat: r.c.csatScore,
      })),
      counts,
    };
  }

  private async counts(principal: Principal, base: SQL | undefined): Promise<Record<InboxView, number>> {
    const f = (view: InboxView) => sql<number>`count(*) FILTER (WHERE ${viewPredicate(view, principal)})::int`;
    const [row] = await this.db
      .select({ all: f('all'), mine: f('mine'), waiting: f('waiting'), ai: f('ai'), human: f('human'), priority: f('priority'), resolved: f('resolved') })
      .from(conversations)
      .where(base);
    return row ?? { all: 0, mine: 0, waiting: 0, ai: 0, human: 0, priority: 0, resolved: 0 };
  }

  private searchPredicate(term: string): SQL {
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    return or(
      ilike(customers.displayName, like),
      ilike(conversations.lastPreview, like),
      sql`EXISTS (SELECT 1 FROM ${customerIdentities} WHERE ${customerIdentities.customerId} = ${conversations.customerId} AND ${customerIdentities.value} ILIKE ${like})`,
      sql`replace(${conversations.id}::text, '-', '') ILIKE ${like.replace('conv_', '')}`,
    )!;
  }
}
