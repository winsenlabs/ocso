import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray } from 'drizzle-orm';
import { customerSafeParts, type ChannelCapabilities } from '@ocso/channels';
import type { InteractionPart } from '@ocso/domain';
import { interactionParts, interactions, users, virtualAgents, type Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';
import { controlChangeFacts, firstName, noticeKind, type WebChatNotice } from './webchat-notices.js';

export interface WebChatMessage {
  id: string;
  seq: number;
  from: 'customer' | 'agent' | 'human';
  name: string | null;
  parts: Array<InteractionPart & { url?: string }>;
  deliveryStatus: string;
  at: string;
  /** The AI turn that produced an agent message (joins streamed deltas to the stored message). */
  turnId: string | null;
  /** The widget's idempotency key for the customer's own messages (reconciles optimistic sends). */
  clientMessageId: string | null;
}

const PAGE = 200;
/** Customer idempotency keys are `webchat:<identity digest>:<clientMessageId>` (packages/channels inbound). */
const CLIENT_KEY = /^webchat:[0-9a-f]{32}:([A-Za-z0-9._:-]{8,128})$/;

type Row = typeof interactions.$inferSelect;

/**
 * Customer-facing message view: only customer-visible MESSAGE interactions and
 * only parts the web-chat channel may render (docs/07 §5). Internal events,
 * notes and tool traces never leave this service; control changes leave only
 * as customer-safe notices.
 */
@Injectable()
export class WebChatMessagesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ConversationAccessService) private readonly media: ConversationAccessService,
  ) {}

  /** `afterSeq` 0 = the latest page (initial load); otherwise the next page after it (gap fill). */
  async list(conversationId: string, capabilities: ChannelCapabilities, afterSeq = 0, agentName: string | null = null): Promise<WebChatMessage[]> {
    const visible = and(eq(interactions.conversationId, conversationId), eq(interactions.visibility, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE'));
    const rows =
      afterSeq > 0
        ? await this.db.select().from(interactions).where(and(visible, gt(interactions.seq, afterSeq))).orderBy(asc(interactions.seq)).limit(PAGE)
        : (await this.db.select().from(interactions).where(visible).orderBy(desc(interactions.seq)).limit(PAGE)).reverse();
    return this.render(rows, capabilities, agentName);
  }

  async one(interactionId: string, capabilities: ChannelCapabilities, agentName: string | null): Promise<WebChatMessage | null> {
    const rows = await this.db.select().from(interactions).where(and(eq(interactions.id, interactionId), eq(interactions.visibility, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE')));
    return (await this.render(rows, capabilities, agentName))[0] ?? null;
  }

  /** Customer-safe notices from control-change system events with seq ≥ `fromSeq`. */
  async notices(conversationId: string, fromSeq: number, agentName: string | null): Promise<WebChatNotice[]> {
    const rows = await this.db
      .select({ id: interactions.id, seq: interactions.seq, at: interactions.createdAt, content: interactionParts.content })
      .from(interactions)
      .innerJoin(interactionParts, eq(interactionParts.interactionId, interactions.id))
      .where(and(eq(interactions.conversationId, conversationId), eq(interactions.kind, 'SYSTEM_EVENT'), gte(interactions.seq, fromSeq)))
      .orderBy(asc(interactions.seq))
      .limit(PAGE);
    return this.toNotices(rows, agentName);
  }

  /** The notice for the control change that was just committed (live stream), if customers should see one. */
  async latestNotice(conversationId: string, change: { from: unknown; to: unknown }, agentName: string | null): Promise<WebChatNotice | null> {
    const rows = await this.db
      .select({ id: interactions.id, seq: interactions.seq, at: interactions.createdAt, content: interactionParts.content })
      .from(interactions)
      .innerJoin(interactionParts, eq(interactionParts.interactionId, interactions.id))
      .where(and(eq(interactions.conversationId, conversationId), eq(interactions.kind, 'SYSTEM_EVENT')))
      .orderBy(desc(interactions.seq))
      .limit(10);
    const match = rows.find((r) => {
      const facts = controlChangeFacts(r.content);
      return facts !== null && facts.from === change.from && facts.to === change.to;
    });
    return match ? ((await this.toNotices([match], agentName))[0] ?? null) : null;
  }

  async firstNameOf(userId: string | null): Promise<string | null> {
    return userId ? ((await this.firstNames([userId])).get(userId) ?? null) : null;
  }

  private async toNotices(rows: Array<{ id: string; seq: number; at: Date; content: unknown }>, agentName: string | null): Promise<WebChatNotice[]> {
    const changes = rows.flatMap((r) => {
      const facts = controlChangeFacts(r.content);
      const kind = facts ? noticeKind(facts) : null;
      return facts && kind ? [{ row: r, facts, kind }] : [];
    });
    const humanIds = [...new Set(changes.filter((c) => c.kind === 'joined' && c.facts.actorId).map((c) => c.facts.actorId!))];
    const names = await this.firstNames(humanIds);
    return changes.map(({ row, facts, kind }) => ({
      id: row.id,
      seq: row.seq,
      kind,
      name: kind === 'joined' ? (names.get(facts.actorId ?? '') ?? null) : kind === 'ai_resumed' ? agentName : null,
      at: row.at.toISOString(),
    }));
  }

  private async firstNames(userIds: string[]): Promise<Map<string, string>> {
    const ids = userIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    return new Map(rows.flatMap((u) => (firstName(u.name) ? [[u.id, firstName(u.name)!] as const] : [])));
  }

  private async render(rows: Row[], capabilities: ChannelCapabilities, agentName: string | null): Promise<WebChatMessage[]> {
    if (!rows.length) return [];
    const parts = await this.db.select().from(interactionParts).where(inArray(interactionParts.interactionId, rows.map((r) => r.id))).orderBy(asc(interactionParts.idx));
    const names = await this.firstNames([...new Set(rows.filter((r) => r.actorType === 'HUMAN' && r.actorId).map((r) => r.actorId!))]);
    // A conversation can change agent (queue transfers): each AI message carries its own agent's name.
    const agentIds = [...new Set(rows.filter((r) => r.actorType === 'AGENT' && r.actorId && /^[0-9a-f-]{36}$/i.test(r.actorId)).map((r) => r.actorId!))];
    const agents = new Map(agentIds.length ? (await this.db.select({ id: virtualAgents.id, name: virtualAgents.name }).from(virtualAgents).where(inArray(virtualAgents.id, agentIds))).map((a) => [a.id, a.name] as const) : []);
    const out: WebChatMessage[] = [];
    for (const r of rows) {
      const own = parts.filter((p) => p.interactionId === r.id).map((p) => p.content as unknown as InteractionPart);
      const safe = r.actorType === 'CUSTOMER' ? own.filter((p) => p.type !== 'TOOL_RESULT') : customerSafeParts(own, capabilities).parts;
      out.push({
        id: r.id,
        seq: r.seq,
        from: r.actorType === 'CUSTOMER' ? 'customer' : r.actorType === 'HUMAN' ? 'human' : 'agent',
        // ROUTER questions show as the assistant (no name: the router is not an agent).
        name: r.actorType === 'HUMAN' && r.actorId ? (names.get(r.actorId) ?? null) : r.actorType === 'AGENT' ? (agents.get(r.actorId ?? '') ?? agentName) : null,
        parts: await this.media.signParts(safe),
        deliveryStatus: r.deliveryStatus,
        at: r.createdAt.toISOString(),
        turnId: r.actorType === 'AGENT' ? r.turnId : null,
        clientMessageId: r.actorType === 'CUSTOMER' ? (CLIENT_KEY.exec(r.idempotencyKey ?? '')?.[1] ?? null) : null,
      });
    }
    return out;
  }
}
