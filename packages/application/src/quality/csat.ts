import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { conflict, displayId, notFound } from '@ocso/domain';
import { conversations, csatResponses, uuidv7, type Db } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { systemActor, type ActorContext } from '../shared/context.js';

export const CsatInput = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2_000).optional(),
});
export type CsatInput = z.infer<typeof CsatInput>;

export interface CsatRecorded {
  id: string;
  conversationId: string;
  score: number;
  handledByHuman: boolean;
  receivedAt: string;
}

export type CsatResponseView = Omit<typeof csatResponses.$inferSelect, 'receivedAt'> & { receivedAt: string };

/**
 * Record one customer satisfaction response (docs/archive/specs/11 §3 "CSAT or configured
 * satisfaction signal"). One response per resolution cycle: a second response
 * received after the conversation's latest resolution (or since it opened, if
 * never resolved) is rejected. handledByHuman = a human sent a customer-visible
 * message in the conversation. conversations.csat_score keeps the latest score.
 */
export async function recordCsat(
  db: Db,
  conversationId: string,
  score: number,
  comment: string | null,
  options: { now?: Date; actor?: ActorContext } = {},
): Promise<CsatRecorded> {
  const input = CsatInput.parse({ score, ...(comment ? { comment } : {}) });
  const now = options.now ?? new Date();
  const actor = options.actor ?? systemActor('csat', `csat:${conversationId}`);
  return db.transaction(async (tx) => {
    const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update');
    if (!conv) throw notFound('conversation', conversationId);
    const cycleStart = conv.resolvedAt ?? conv.openedAt;
    const [dup] = await tx
      .select({ id: csatResponses.id })
      .from(csatResponses)
      .where(and(eq(csatResponses.conversationId, conversationId), gte(csatResponses.receivedAt, cycleStart)))
      .limit(1);
    if (dup) throw conflict('csat_already_recorded', 'A satisfaction response was already recorded for this conversation');
    if (!conv.agentId) throw conflict('conversation_routing', 'The conversation has no agent yet (a router is still deciding)');
    const handled = await tx.execute<{ human: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM interactions WHERE conversation_id = ${conversationId} AND actor_type = 'HUMAN' AND kind = 'MESSAGE' AND visibility = 'CUSTOMER') AS human`,
    );
    const handledByHuman = Boolean(handled.rows[0]?.human);
    const id = uuidv7();
    const agentId = conv.agentId;
    await tx.insert(csatResponses).values({ id, conversationId, agentId, handledByHuman, score: input.score, comment: input.comment ?? null, receivedAt: now });
    await tx.update(conversations).set({ csatScore: input.score, updatedAt: now }).where(eq(conversations.id, conversationId));
    if (actor.principal) {
      await recordAudit(tx, actor, { action: 'csat.record', targetType: 'conversation', targetId: conversationId, summary: `Recorded CSAT ${input.score}/5 for ${displayId('conv', conversationId)}` });
    }
    await emitEvent(tx, actor, 'conversation.updated', { fields: ['csatScore'] }, { conversationId, agentId: conv.agentId });
    return { id, conversationId, score: input.score, handledByHuman, receivedAt: now.toISOString() };
  });
}

/** Staff-facing CSAT: read responses and record one collected outside the channel (e.g. on a call). */
export class CsatService {
  constructor(private readonly db: Db) {}

  async list(conversationId: string): Promise<CsatResponseView[]> {
    const rows = await this.db.select().from(csatResponses).where(eq(csatResponses.conversationId, conversationId)).orderBy(desc(csatResponses.receivedAt));
    return rows.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString() }));
  }

  /** Caller has checked conversation access; requires conversations.reply (the person talking to the customer). */
  async record(actor: ActorContext, conversationId: string, input: CsatInput): Promise<CsatRecorded> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_REPLY);
    return recordCsat(this.db, conversationId, input.score, input.comment ?? null, { actor });
  }
}

