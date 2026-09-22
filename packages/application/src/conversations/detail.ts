import { and, desc, eq, isNull } from 'drizzle-orm';
import { displayId, sessionWindowState, type SessionWindowState } from '@ocso/domain';
import {
  channels,
  conversationSummaries,
  conversations,
  customerIdentities,
  customers,
  handoffs,
  modelProfiles,
  promptVersions,
  queues,
  users,
  virtualAgents,
  type Db,
} from '@ocso/db';
import { maskIdentity } from './masking.js';
import { lastCustomerMessageAt, type SessionWindowHours } from './session-window.js';

export interface ConversationDetail {
  id: string;
  displayId: string;
  type: string;
  controlState: string;
  priority: string;
  version: number;
  openedAt: string;
  resolvedAt: string | null;
  disposition: string | null;
  tags: string[];
  waitingSince: string | null;
  slaDueAt: string | null;
  resolutionDueAt: string | null;
  customer: { id: string; name: string | null; language: string | null; attributes: Record<string, unknown>; identities: Array<{ kind: string; value: string }> };
  channel: { id: string; kind: string; name: string } | null;
  agent: { id: string; name: string; conversationType: string; status: string };
  promptVersion: { id: string; version: number } | null;
  modelProfile: { id: string; name: string } | null;
  queue: { id: string; name: string } | null;
  assignedUser: { id: string; name: string } | null;
  summary: { version: number; text: string; coversThroughSeq: number; createdAt: string } | null;
  openHandoff: {
    id: string;
    status: string;
    reasonText: string;
    mode: string;
    requestedAt: string;
    agentSummary: string | null;
    offerExpiresAt: string | null;
  } | null;
  /** Latest human-written handover summary (return to AI), if any. */
  handover: { version: number; text: string; createdAt: string } | null;
  resolvedBy: { id: string; name: string } | null;
  firstHumanResponseAt: string | null;
  /**
   * WhatsApp customer-service window (docs/07 §3): free-form replies only
   * while open; afterwards an approved template. Null for channels without a
   * window (web chat).
   */
  whatsappWindow: SessionWindowState | null;
}

/** Context rail data for the workspace (design/01 right rail). Caller checks access. */
export async function loadConversationDetail(
  db: Db,
  conversationId: string,
  options: { windowHours?: SessionWindowHours | undefined; now?: Date | undefined } = {},
): Promise<ConversationDetail | null> {
  const [row] = await db
    .select({ c: conversations, customer: customers, agent: virtualAgents, channel: channels, queue: queues, assignee: users })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .innerJoin(virtualAgents, eq(virtualAgents.id, conversations.agentId))
    .leftJoin(channels, eq(channels.id, conversations.channelId))
    .leftJoin(queues, eq(queues.id, conversations.queueId))
    .leftJoin(users, eq(users.id, conversations.assignedUserId))
    .where(eq(conversations.id, conversationId));
  if (!row) return null;
  const { c, customer, agent, channel, queue, assignee } = row;
  const [identities, [summary], [handover], [handoff], [prompt], [profile], [resolver]] = await Promise.all([
    db.select({ kind: customerIdentities.kind, value: customerIdentities.value }).from(customerIdentities).where(eq(customerIdentities.customerId, customer.id)),
    db.select().from(conversationSummaries).where(and(eq(conversationSummaries.conversationId, c.id), eq(conversationSummaries.kind, 'ROLLING'))).orderBy(desc(conversationSummaries.version)).limit(1),
    db.select().from(conversationSummaries).where(and(eq(conversationSummaries.conversationId, c.id), eq(conversationSummaries.kind, 'HANDOVER'))).orderBy(desc(conversationSummaries.version)).limit(1),
    db.select().from(handoffs).where(and(eq(handoffs.conversationId, c.id), isNull(handoffs.resolvedAt), isNull(handoffs.cancelledAt), isNull(handoffs.returnedAt))).orderBy(desc(handoffs.requestedAt)).limit(1),
    agent.activePromptVersionId ? db.select({ id: promptVersions.id, version: promptVersions.version }).from(promptVersions).where(eq(promptVersions.id, agent.activePromptVersionId)) : Promise.resolve([]),
    agent.modelProfileId ? db.select({ id: modelProfiles.id, name: modelProfiles.name }).from(modelProfiles).where(eq(modelProfiles.id, agent.modelProfileId)) : Promise.resolve([]),
    c.resolvedBy ? db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, c.resolvedBy)) : Promise.resolve([]),
  ]);
  const hours = channel && options.windowHours ? options.windowHours(channel) : null;
  const whatsappWindow = channel && hours !== null ? sessionWindowState(hours, await lastCustomerMessageAt(db, customer.id, channel.id), options.now ?? new Date()) : null;
  return {
    id: c.id,
    displayId: displayId('conv', c.id),
    type: c.type,
    controlState: c.controlState,
    priority: c.priority,
    version: c.version,
    openedAt: c.openedAt.toISOString(),
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    disposition: c.disposition,
    tags: c.tags,
    waitingSince: c.waitingSince?.toISOString() ?? null,
    slaDueAt: c.slaDueAt?.toISOString() ?? null,
    resolutionDueAt: c.resolutionDueAt?.toISOString() ?? null,
    customer: {
      id: customer.id,
      name: customer.displayName,
      language: customer.language,
      attributes: customer.attributes,
      identities: identities.map((i) => ({ kind: i.kind, value: maskIdentity(`${i.kind}:${i.value}`) ?? i.value })),
    },
    channel: channel ? { id: channel.id, kind: channel.kind, name: channel.name } : null,
    agent: { id: agent.id, name: agent.name, conversationType: agent.conversationType, status: agent.status },
    promptVersion: prompt ?? null,
    modelProfile: profile ?? null,
    queue: queue ? { id: queue.id, name: queue.name } : null,
    assignedUser: assignee ? { id: assignee.id, name: assignee.name } : null,
    summary: summary ? { version: summary.version, text: summary.text, coversThroughSeq: summary.coversThroughSeq, createdAt: summary.createdAt.toISOString() } : null,
    openHandoff: handoff
      ? {
          id: handoff.id,
          status: handoff.status,
          reasonText: handoff.reasonText,
          mode: handoff.mode,
          requestedAt: handoff.requestedAt.toISOString(),
          agentSummary: handoff.agentSummary,
          offerExpiresAt: handoff.offerExpiresAt?.toISOString() ?? null,
        }
      : null,
    handover: handover ? { version: handover.version, text: handover.text, createdAt: handover.createdAt.toISOString() } : null,
    resolvedBy: resolver ?? null,
    firstHumanResponseAt: c.firstHumanResponseAt?.toISOString() ?? null,
    whatsappWindow,
  };
}
