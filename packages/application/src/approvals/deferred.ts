import { and, eq, isNull, sql } from 'drizzle-orm';
import { approvalProposals, type Db } from '@ocso/db';
import { approvalTransition, isDomainError } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';
import type { ProposalRow } from './contract.js';
import type { ApprovalRegistry } from './registry.js';
import { emitDecided, recordDecision } from './records.js';
import { assessProposal } from './warnings.js';

export type FinishOutcome = 'ACTIVATED' | 'BLOCKED' | 'SKIPPED';

/** After this many attempts a deferred activation that keeps failing is blocked, never left half-live. */
export const MAX_ACTIVATION_ATTEMPTS = 5;

/**
 * Finish an approved, DEFERRED activation (PM/research/11b "Deferred
 * activation"), outside any transaction because it talks to a provider. It
 * re-runs validation and re-checks both hashes first: re-validate at
 * activation, not only at approval. Nothing a provider rejects ever shows as live.
 */
export async function finishDeferredActivation(
  db: Db,
  registry: ApprovalRegistry,
  actor: ActorContext,
  proposalId: string,
  o: { now: () => Date; notify: (id: string) => Promise<void> },
): Promise<FinishOutcome> {
  // Exactly one runner per proposal: a transaction holds a try-lock on the proposal for the whole attempt,
  // provider call included. A second consumer (queue redelivery during a slow provider call, a redispatch
  // after a crash) skips instead of calling the provider again; a crashed runner's lock dies with its
  // connection. The provider work itself runs on other connections (`db`), never inside this transaction.
  return db.transaction(async (claim) => {
    const got = await claim.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`ocso:approval-activate:${proposalId}`})) AS ok`);
    if (!got.rows[0]?.ok) return 'SKIPPED';
    return runActivation(db, registry, actor, proposalId, o);
  });
}

async function runActivation(
  db: Db,
  registry: ApprovalRegistry,
  actor: ActorContext,
  proposalId: string,
  o: { now: () => Date; notify: (id: string) => Promise<void> },
): Promise<FinishOutcome> {
  const [p] = await db.select().from(approvalProposals).where(eq(approvalProposals.id, proposalId));
  // MIGRATION rows (grandfathered live config) were never activated by OCSO and are never finished here.
  if (!p || p.origin !== 'USER' || p.status !== 'APPROVED' || p.activatedAt !== null || !registry.has(p.objectKind)) return 'SKIPPED';
  const d = registry.get(p.objectKind);
  if (!d.activateDeferred) return block(db, actor, p, `${d.label} has no deferred activation`, o);
  // Already in effect (committed by `activate`, or by an earlier attempt that crashed before the stamp below):
  // re-checking would compare against the changed object and block a change that is live. Finish it instead.
  const settled = d.settled ? await d.settled(db, p) : false;
  if (!settled) {
    const a = await assessProposal(db, d, p, { viewer: null, now: o.now(), ageThresholdHours: Number.POSITIVE_INFINITY });
    if (a.liveContentHash !== p.contentHash) return block(db, actor, p, 'The object changed after approval; submit the change again.', o);
    if (a.liveDependencyHash !== p.dependencyHash) return block(db, actor, p, 'Something this change relies on changed after approval; submit it again.', o);
    if (a.problems.length) return block(db, actor, p, a.problems.map((x) => x.message).join(' '), o);
  }
  // Counted (and committed) before the provider call, so a runner that keeps failing is eventually blocked.
  const [counted] = await db
    .update(approvalProposals)
    .set({ activationAttempts: sql`${approvalProposals.activationAttempts} + 1`, updatedAt: o.now() })
    .where(and(eq(approvalProposals.id, p.id), eq(approvalProposals.status, 'APPROVED'), isNull(approvalProposals.activatedAt)))
    .returning();
  if (!counted) return 'SKIPPED';
  let followUpFailed: string | null = null;
  try {
    await d.activateDeferred(db, actor, counted);
  } catch (err) {
    const terminal = (isDomainError(err) && !err.retriable) || counted.activationAttempts >= MAX_ACTIVATION_ATTEMPTS;
    if (!terminal) throw err;
    const reason = err instanceof Error ? err.message : 'Activation failed';
    // A settled change is live: its follow-up failing (an invite email) is recorded, never turned into BLOCKED.
    if (!settled) return block(db, actor, counted, reason, o);
    followUpFailed = `Applied; the follow-up step failed: ${reason}`;
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvalProposals)
      .set({ activatedAt: o.now(), updatedAt: o.now() })
      .where(and(eq(approvalProposals.id, p.id), isNull(approvalProposals.activatedAt)))
      .returning();
    if (row) await recordDecision(tx, actor, row, 'ACTIVATE', followUpFailed ? { reason: followUpFailed } : {});
  });
  return 'ACTIVATED';
}

async function block(db: Db, actor: ActorContext, p: ProposalRow, reason: string, o: { now: () => Date; notify: (id: string) => Promise<void> }): Promise<FinishOutcome> {
  approvalTransition(p.status, 'BLOCK');
  const blocked = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvalProposals)
      .set({ status: 'BLOCKED', blockedReason: reason, updatedAt: o.now() })
      .where(and(eq(approvalProposals.id, p.id), eq(approvalProposals.status, 'APPROVED'), isNull(approvalProposals.activatedAt)))
      .returning();
    if (!row) return false;
    await recordDecision(tx, actor, row, 'BLOCK', { reason });
    await emitDecided(tx, actor, row, 'BLOCKED');
    return true;
  });
  if (!blocked) return 'SKIPPED';
  await o.notify(p.id);
  return 'BLOCKED';
}
