import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { InteractionPart } from '@ocso/domain';
import { interactionParts, interactions, users, type DbOrTx } from '@ocso/db';
import type { HistoryEntry } from '@ocso/prompt-compiler';

/**
 * Customer-visible messages in (fromSeq, toSeq], newest `limit` kept, returned
 * oldest-first. Internal events, notes and tool traces are never included.
 */
export async function loadHistory(db: DbOrTx, conversationId: string, fromSeqExclusive: number, toSeqInclusive: number, limit: number): Promise<HistoryEntry[]> {
  if (toSeqInclusive <= fromSeqExclusive) return [];
  const rows = await db
    .select({ id: interactions.id, seq: interactions.seq, actorType: interactions.actorType, actorId: interactions.actorId })
    .from(interactions)
    .where(
      and(
        eq(interactions.conversationId, conversationId),
        eq(interactions.kind, 'MESSAGE'),
        eq(interactions.visibility, 'CUSTOMER'),
        gt(interactions.seq, fromSeqExclusive),
        lte(interactions.seq, toSeqInclusive),
      ),
    )
    .orderBy(desc(interactions.seq))
    .limit(limit);
  rows.reverse();
  return attachParts(db, rows);
}

/** Customer messages not yet answered by a turn. */
export async function loadPending(db: DbOrTx, conversationId: string, afterSeq: number): Promise<HistoryEntry[]> {
  const rows = await db
    .select({ id: interactions.id, seq: interactions.seq, actorType: interactions.actorType, actorId: interactions.actorId })
    .from(interactions)
    .where(and(eq(interactions.conversationId, conversationId), eq(interactions.actorType, 'CUSTOMER'), eq(interactions.kind, 'MESSAGE'), gt(interactions.seq, afterSeq)))
    .orderBy(asc(interactions.seq))
    .limit(50);
  return attachParts(db, rows);
}

async function attachParts(
  db: DbOrTx,
  rows: Array<{ id: string; seq: number; actorType: string; actorId: string | null }>,
): Promise<HistoryEntry[]> {
  if (!rows.length) return [];
  const parts = await db
    .select()
    .from(interactionParts)
    .where(inArray(interactionParts.interactionId, rows.map((r) => r.id)))
    .orderBy(asc(interactionParts.idx));
  const byInteraction = new Map<string, InteractionPart[]>();
  for (const p of parts) {
    const list = byInteraction.get(p.interactionId) ?? [];
    list.push(p.content as unknown as InteractionPart);
    byInteraction.set(p.interactionId, list);
  }
  const humanIds = [...new Set(rows.filter((r) => r.actorType === 'HUMAN' && r.actorId).map((r) => r.actorId!))];
  const names = new Map(
    humanIds.length ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, humanIds))).map((u) => [u.id, u.name]) : [],
  );
  return rows
    .filter((r) => r.actorType === 'CUSTOMER' || r.actorType === 'AGENT' || r.actorType === 'HUMAN' || r.actorType === 'ROUTER')
    .map((r) => ({
      seq: r.seq,
      actorType: r.actorType as HistoryEntry['actorType'],
      actorName: r.actorType === 'HUMAN' && r.actorId ? names.get(r.actorId) : undefined,
      parts: byInteraction.get(r.id) ?? [],
    }));
}
