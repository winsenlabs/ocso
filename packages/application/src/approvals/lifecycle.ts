import { and, eq, isNull, lt } from 'drizzle-orm';
import { can } from '@ocso/auth';
import { approvalProposals, type Db } from '@ocso/db';
import { TOPICS, type QueueAdapter, type Topic } from '@ocso/queue';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { isEligibleChecker, loadPerson } from './access.js';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';
import { voidOpen } from './decisions.js';
import type { ApprovalLogger } from './queries.js';
import type { ApprovalRegistry } from './registry.js';

/**
 * Leader sweeps of the approval spine (PM/research/11b). Each is idempotent.
 * The checker sweep flags; it never reassigns — silently moving authority is
 * exactly what maker–checker exists to prevent.
 */

type Publisher = Pick<QueueAdapter, 'publish'>;
type Log = ApprovalLogger | undefined;

/** Publish, reporting (never swallowing silently) a failure: the next sweep publishes it again. */
function publishOrLog(queue: Publisher, log: Log, topic: Topic, payload: Record<string, unknown>, dedupeKey: string): Promise<void> {
  return queue.publish(topic, payload, { dedupeKey }).then(
    () => undefined,
    (err: unknown) => log?.warn({ topic, dedupeKey, err }, 'approval job publish failed; the next sweep retries it'),
  );
}

/** Re-evaluate every open proposal's checker: flags (and unflags) `checker_valid`, announces the loss. */
export async function revalidateCheckers(db: Db, registry: ApprovalRegistry, queue: Publisher, actor: ActorContext, log?: Log): Promise<{ invalidated: number; restored: number }> {
  const open = await db.select().from(approvalProposals).where(eq(approvalProposals.status, 'SUBMITTED'));
  let invalidated = 0;
  let restored = 0;
  for (const p of open) {
    if (!p.checkerId || !registry.has(p.objectKind) || p.bootstrap) continue;
    const d = registry.get(p.objectKind);
    const person = await loadPerson(db, p.checkerId);
    const valid = await isEligibleChecker(db, d, p, person);
    if (valid === p.checkerValid) continue;
    await db.transaction(async (tx) => {
      await tx.update(approvalProposals).set({ checkerValid: valid, updatedAt: new Date() }).where(and(eq(approvalProposals.id, p.id), eq(approvalProposals.status, 'SUBMITTED')));
      if (!valid) {
        await emitEvent(tx, actor, 'approval.checker_invalid', {
          proposalId: p.id,
          objectKind: p.objectKind,
          checkerId: p.checkerId!,
          reason: person ? 'LOST_RIGHTS' : 'DISABLED',
          makerId: p.makerId ?? '',
        });
      }
    });
    if (valid) restored++;
    else {
      invalidated++;
      await publishOrLog(queue, log, TOPICS.APPROVAL_NOTIFY, { proposalId: p.id, kind: 'CHECKER_INVALID' }, `approval-notify:${p.id}:checker-invalid:${p.checkerId}`);
    }
  }
  return { invalidated, restored };
}

/** Checkers never emailed (a crash between commit and publish): publish again once a minute has passed. */
export async function redispatchApprovalNotices(db: Db, queue: Publisher, now = new Date(), log?: Log): Promise<number> {
  const stale = await db
    .select({ id: approvalProposals.id })
    .from(approvalProposals)
    .where(and(eq(approvalProposals.status, 'SUBMITTED'), isNull(approvalProposals.notifiedAt), lt(approvalProposals.updatedAt, new Date(now.getTime() - 60_000))))
    .limit(200);
  for (const row of stale) await publishOrLog(queue, log, TOPICS.APPROVAL_NOTIFY, { proposalId: row.id, kind: 'REQUESTED' }, `approval-notify:${row.id}:requested:redispatch`);
  return stale.length;
}

/** Approved proposals still waiting for their deferred activation get their job again (the consumer is idempotent). */
export async function redispatchActivations(db: Db, queue: Publisher, now = new Date(), log?: Log): Promise<number> {
  const stale = await db
    .select({ id: approvalProposals.id })
    .from(approvalProposals)
    .where(and(eq(approvalProposals.status, 'APPROVED'), eq(approvalProposals.origin, 'USER'), isNull(approvalProposals.activatedAt), lt(approvalProposals.updatedAt, new Date(now.getTime() - 120_000))))
    .limit(100);
  for (const row of stale) await publishOrLog(queue, log, TOPICS.APPROVAL_ACTIVATE, { proposalId: row.id }, `approval-activate:${row.id}`);
  return stale.length;
}

/**
 * Open proposals nobody should decide any more are voided (VOID decision + audit), so they stop locking
 * their object: the object is gone, or the maker is no longer ACTIVE or no longer holds the permission to
 * make this change (a change stands on its maker's authority at the time it would apply).
 */
export async function voidOrphanProposals(db: Db, registry: ApprovalRegistry, actor: ActorContext): Promise<number> {
  const open = await db.select().from(approvalProposals).where(eq(approvalProposals.status, 'SUBMITTED'));
  let voided = 0;
  for (const p of open) {
    if (!registry.has(p.objectKind)) continue;
    const d = registry.get(p.objectKind);
    const reason = await voidReason(db, d, p);
    if (!reason) continue;
    const done = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(approvalProposals).where(and(eq(approvalProposals.id, p.id), eq(approvalProposals.status, 'SUBMITTED'))).for('update');
      if (!locked) return false;
      await voidOpen(tx, actor, locked, reason, new Date(), null);
      return true;
    });
    if (done) voided++;
  }
  return voided;
}

async function voidReason(db: Db, d: ApprovalDescriptor, p: ProposalRow): Promise<string | null> {
  if ((await d.project(db, p.objectId)) === null) return 'The object no longer exists';
  if (!p.makerId) return null;
  const maker = await loadPerson(db, p.makerId);
  if (!maker) return "The maker's account is no longer active";
  if (!can(maker, d.makePermission(p.action))) return 'The maker no longer holds the permission to make this change';
  return null;
}
