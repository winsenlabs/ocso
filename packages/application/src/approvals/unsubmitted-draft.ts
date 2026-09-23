import { and, eq } from 'drizzle-orm';
import { approvalProposals, type Db, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { lockObject } from './guard.js';

/**
 * Undo a draft created by the same request whose submission then failed (no eligible checker, bootstrap refused,
 * validation): the request failed as a whole, so a retry does not leave a duplicate draft or a reserved name. Only
 * while nothing was ever proposed on the object — anything that reached the spine is governed and stays.
 */
export async function discardUnsubmittedDraft(
  db: Db,
  actor: ActorContext,
  o: { kind: string; id: string; name: string; remove: (tx: DbOrTx) => Promise<void> },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockObject(tx, `${o.kind}:${o.id}`);
    const [proposed] = await tx.select({ id: approvalProposals.id }).from(approvalProposals).where(and(eq(approvalProposals.objectKind, o.kind), eq(approvalProposals.objectId, o.id))).limit(1);
    if (proposed) return;
    await o.remove(tx);
    await recordAudit(tx, actor, { action: `${o.kind}.discard`, targetType: o.kind, targetId: o.id, summary: `Discarded draft ${o.name}: its submission for approval failed` });
  });
}

/** Run `submit` for a draft just created; if it throws, discard the draft and rethrow. */
export async function submitOrDiscard<T>(submit: () => Promise<T>, discard: () => Promise<void>): Promise<T> {
  try {
    return await submit();
  } catch (err) {
    await discard();
    throw err;
  }
}
