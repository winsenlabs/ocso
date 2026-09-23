import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { partToPlainText, routerReplyOf, type InteractionPart, type RouterReply, type RoutingSession, type SessionContext } from '@ocso/domain';
import { conversationRouting, customers, interactionParts, interactions, type DbOrTx } from '@ocso/db';
import type { ActiveRouter } from './router-load.js';

export type RoutingRow = typeof conversationRouting.$inferSelect;

export function sessionOf(row: RoutingRow): RoutingSession {
  return {
    phase: row.phase,
    stepIndex: row.stepIndex,
    attributes: row.attributes,
    answers: row.answers,
    classifications: row.classifications,
    followUps: row.followUps,
    attempts: row.attempts,
    awaiting: row.awaitingSince !== null,
  };
}

/** Session → row columns; `awaiting_since` keeps its first value while the router keeps waiting. */
export function sessionColumns(session: RoutingSession, previous: Date | null, now: Date) {
  return {
    phase: session.phase,
    stepIndex: session.stepIndex,
    attributes: session.attributes,
    answers: session.answers,
    classifications: session.classifications,
    followUps: session.followUps,
    attempts: session.attempts,
    awaitingSince: session.awaiting ? (previous ?? now) : null,
    updatedAt: now,
  };
}

/**
 * Start (or restart) routing for a conversation: one row per conversation,
 * reset each time. `seqFrom` is where the agent's unanswered messages begin.
 */
export async function startRoutingRow(
  tx: DbOrTx,
  input: { conversationId: string; active: ActiveRouter; phase: 'RETURNING' | 'STEPS'; previousState: string | null; seqFrom: number; now: Date },
): Promise<void> {
  const values = {
    routerId: input.active.router.id,
    routerVersionId: input.active.version.id,
    phase: input.phase,
    stepIndex: 0,
    attributes: {},
    answers: {},
    classifications: {},
    followUps: 0,
    attempts: 0,
    previousState: input.previousState,
    awaitingSince: null,
    seqFrom: input.seqFrom,
    outcome: null,
    ruleIndex: null,
    queueId: null,
    decidedAt: null,
    updatedAt: input.now,
  };
  await tx
    .insert(conversationRouting)
    .values({ conversationId: input.conversationId, ...values })
    .onConflictDoUpdate({ target: conversationRouting.conversationId, set: values });
}

/** KNOWN step values from the customer record. */
export async function knownContext(tx: DbOrTx, customerId: string): Promise<SessionContext> {
  const [customer] = await tx.select({ language: customers.language, attributes: customers.attributes }).from(customers).where(eq(customers.id, customerId));
  return {
    known(from) {
      if (from === 'customer.language') return customer?.language?.trim() || null;
      const key = from.startsWith('customer.attribute:') ? from.slice('customer.attribute:'.length) : null;
      const value = key ? customer?.attributes[key] : undefined;
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() || null : null;
    },
  };
}

export interface CustomerMessage {
  id: string;
  seq: number;
  idempotencyKey: string | null;
  parts: InteractionPart[];
}

/** Customer messages after `afterSeq`, oldest first, with their parts. */
export async function customerMessagesAfter(tx: DbOrTx, conversationId: string, afterSeq: number, upToSeq?: number): Promise<CustomerMessage[]> {
  const rows = await tx
    .select({ id: interactions.id, seq: interactions.seq, idempotencyKey: interactions.idempotencyKey })
    .from(interactions)
    .where(and(eq(interactions.conversationId, conversationId), eq(interactions.actorType, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE'), gt(interactions.seq, afterSeq)))
    .orderBy(asc(interactions.seq))
    .limit(100);
  const within = upToSeq === undefined ? rows : rows.filter((r) => r.seq < upToSeq);
  if (!within.length) return [];
  const parts = await tx
    .select()
    .from(interactionParts)
    .where(inArray(interactionParts.interactionId, within.map((r) => r.id)))
    .orderBy(asc(interactionParts.idx));
  return within.map((r) => ({ ...r, parts: parts.filter((p) => p.interactionId === r.id).map((p) => p.content as unknown as InteractionPart) }));
}

export const replyOf = (message: CustomerMessage): RouterReply => routerReplyOf(message.parts);

/** Customer messages and router questions since routing started, as plain text for the classifier. */
export async function transcript(tx: DbOrTx, conversationId: string, afterSeq: number): Promise<Array<{ from: 'customer' | 'router'; text: string }>> {
  const rows = await tx
    .select({ seq: interactions.seq, actorType: interactions.actorType, content: interactionParts.content })
    .from(interactions)
    .innerJoin(interactionParts, eq(interactionParts.interactionId, interactions.id))
    .where(and(eq(interactions.conversationId, conversationId), eq(interactions.kind, 'MESSAGE'), eq(interactions.visibility, 'CUSTOMER'), gt(interactions.seq, afterSeq)))
    .orderBy(asc(interactions.seq), asc(interactionParts.idx))
    .limit(200);
  const out: Array<{ from: 'customer' | 'router'; seq: number; text: string }> = [];
  for (const r of rows) {
    if (r.actorType !== 'CUSTOMER' && r.actorType !== 'ROUTER') continue;
    const text = partToPlainText(r.content as never);
    const last = out.at(-1);
    if (last && last.seq === r.seq) last.text = `${last.text} ${text}`;
    else out.push({ from: r.actorType === 'CUSTOMER' ? 'customer' : 'router', seq: r.seq, text });
  }
  return out.slice(-40).map(({ from, text }) => ({ from, text }));
}
