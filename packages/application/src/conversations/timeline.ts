import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { InteractionPart } from '@ocso/domain';
import { internalNotes, interactionParts, interactions, toolCalls, tools, users, mcpConnections, virtualAgents, type Db } from '@ocso/db';

export type TimelineItem =
  | {
      kind: 'message';
      id: string;
      seq: number;
      /** ROUTER: a router's question (PM/research/11 §5). */
      actorType: 'CUSTOMER' | 'AGENT' | 'HUMAN' | 'ROUTER';
      actorId: string | null;
      /** The human's name; the agent's name for AGENT messages (a conversation can change agent on transfers). */
      actorName: string | null;
      direction: string;
      deliveryStatus: string;
      deliveryError: string | null;
      parts: InteractionPart[];
      turnId: string | null;
      at: string;
    }
  | { kind: 'system'; id: string; seq: number; schema: string; text: string; data: Record<string, unknown>; at: string }
  | { kind: 'note'; id: string; authorId: string; authorName: string; body: string; passToAgent: boolean; at: string }
  | {
      kind: 'tool';
      id: string;
      toolName: string;
      connectionName: string | null;
      riskClass: string | null;
      status: string;
      actorType: string;
      decisionReason: string | null;
      confirmedByName: string | null;
      latencyMs: number | null;
      summary: unknown;
      /** Sanitized (audit-safe) arguments — what a confirming human is shown. */
      args: unknown;
      /** Confirmation deadline while AWAITING_CONFIRMATION. */
      expiresAt: string | null;
      errorCategory: string | null;
      at: string;
    };

/**
 * Staff timeline: customer-visible messages, internal system events, internal
 * notes and tool events merged in time order (design/01 centre pane). Access
 * checks happen before this is called.
 */
export async function loadTimeline(db: Db, conversationId: string, options: { afterSeq?: number | undefined } = {}): Promise<TimelineItem[]> {
  const rows = await db
    .select()
    .from(interactions)
    .where(and(eq(interactions.conversationId, conversationId), options.afterSeq ? gt(interactions.seq, options.afterSeq) : undefined))
    .orderBy(asc(interactions.seq));
  const ids = rows.map((r) => r.id);
  const parts = ids.length
    ? await db.select().from(interactionParts).where(inArray(interactionParts.interactionId, ids)).orderBy(asc(interactionParts.idx))
    : [];
  const partsBy = new Map<string, InteractionPart[]>();
  for (const p of parts) {
    const list = partsBy.get(p.interactionId) ?? [];
    list.push(p.content as unknown as InteractionPart);
    partsBy.set(p.interactionId, list);
  }
  const humanIds = [...new Set(rows.filter((r) => r.actorType === 'HUMAN' && r.actorId).map((r) => r.actorId!))];
  const names = new Map(
    humanIds.length ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, humanIds))).map((u) => [u.id, u.name]) : [],
  );
  const agentIds = [...new Set(rows.filter((r) => r.actorType === 'AGENT' && r.actorId && /^[0-9a-f-]{36}$/i.test(r.actorId)).map((r) => r.actorId!))];
  const agentNames = new Map(
    agentIds.length ? (await db.select({ id: virtualAgents.id, name: virtualAgents.name }).from(virtualAgents).where(inArray(virtualAgents.id, agentIds))).map((a) => [a.id, a.name]) : [],
  );

  const items: TimelineItem[] = rows.map((r) => {
    const p = partsBy.get(r.id) ?? [];
    if (r.kind === 'SYSTEM_EVENT') {
      const first = p[0];
      const structured = first?.type === 'STRUCTURED' ? first : null;
      return { kind: 'system', id: r.id, seq: r.seq, schema: structured?.schema ?? 'system', text: structured?.fallbackText ?? '', data: structured?.data ?? {}, at: r.createdAt.toISOString() };
    }
    return {
      kind: 'message',
      id: r.id,
      seq: r.seq,
      actorType: r.actorType as 'CUSTOMER' | 'AGENT' | 'HUMAN' | 'ROUTER',
      actorId: r.actorId,
      actorName: !r.actorId ? null : r.actorType === 'HUMAN' ? (names.get(r.actorId) ?? null) : r.actorType === 'AGENT' ? (agentNames.get(r.actorId) ?? null) : null,
      direction: r.direction,
      deliveryStatus: r.deliveryStatus,
      deliveryError: r.deliveryError,
      parts: p,
      turnId: r.turnId,
      at: r.createdAt.toISOString(),
    };
  });

  if (!options.afterSeq) {
    items.push(...(await loadNotes(db, conversationId)), ...(await loadToolEvents(db, conversationId)));
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

async function loadNotes(db: Db, conversationId: string): Promise<TimelineItem[]> {
  const rows = await db
    .select({ n: internalNotes, authorName: users.name })
    .from(internalNotes)
    .innerJoin(users, eq(users.id, internalNotes.authorId))
    .where(eq(internalNotes.conversationId, conversationId));
  return rows.map(({ n, authorName }) => ({
    kind: 'note',
    id: n.id,
    authorId: n.authorId,
    authorName,
    body: n.body,
    passToAgent: n.passToAgent,
    at: n.createdAt.toISOString(),
  }));
}

async function loadToolEvents(db: Db, conversationId: string): Promise<TimelineItem[]> {
  const rows = await db
    .select({ c: toolCalls, riskClass: tools.riskClass, connectionName: mcpConnections.name, confirmedByName: users.name })
    .from(toolCalls)
    .leftJoin(tools, eq(tools.id, toolCalls.toolId))
    .leftJoin(mcpConnections, eq(mcpConnections.id, toolCalls.connectionId))
    .leftJoin(users, eq(users.id, toolCalls.confirmedBy))
    .where(eq(toolCalls.conversationId, conversationId));
  return rows.map(({ c, riskClass, connectionName, confirmedByName }) => ({
    kind: 'tool',
    id: c.id,
    toolName: c.toolName,
    connectionName,
    riskClass,
    status: c.status,
    actorType: c.actorType,
    decisionReason: c.decisionReason ?? c.confirmationReason,
    confirmedByName,
    latencyMs: c.latencyMs,
    summary: c.resultSummary,
    args: c.argsSanitized,
    expiresAt: c.confirmationExpiresAt?.toISOString() ?? null,
    errorCategory: c.errorCategory,
    at: c.requestedAt.toISOString(),
  }));
}
