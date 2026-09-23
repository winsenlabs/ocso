import { eq } from 'drizzle-orm';
import { approvalProposals, type DbOrTx } from '@ocso/db';
import { approvalTransition, type ApprovalWarning } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';
import { emitDecided, proposalDiff, recordDecision } from './records.js';

export type DecisionOutcome = 'APPROVED' | 'REJECTED' | 'BLOCKED';

export interface ApplyDecisionOptions {
  reason: string | null;
  now: Date;
  warnings: readonly ApprovalWarning[];
  /** The dependency hash the checker approved against (stored so deferred activation re-checks exactly it). */
  dependencyHash: string;
  bulkBatchId?: string | null | undefined;
}

/**
 * Approve (or reject) a locked, open proposal and — for approval — apply it in
 * the same transaction, so there is no stale-approval window (PM/research/11b).
 * Validation runs again here: problems → BLOCKED, the object untouched, and the
 * caller commits the block. A genuine error thrown by `activate` rolls the
 * whole transaction back and the proposal stays open.
 */
export async function applyDecision(
  tx: DbOrTx,
  d: ApprovalDescriptor,
  actor: ActorContext,
  p: ProposalRow,
  kind: 'APPROVE' | 'BOOTSTRAP_APPROVE' | 'REJECT',
  o: ApplyDecisionOptions,
): Promise<{ outcome: DecisionOutcome; deferred: boolean }> {
  const decidedBy = actor.principal?.userId ?? null;
  const diff = proposalDiff(p);
  if (kind === 'REJECT') {
    approvalTransition(p.status, 'REJECT');
    const [row] = await tx
      .update(approvalProposals)
      .set({ status: 'REJECTED', decidedAt: o.now, decidedBy, decisionReason: o.reason, warnings: [...o.warnings], updatedAt: o.now })
      .where(eq(approvalProposals.id, p.id))
      .returning();
    await recordDecision(tx, actor, row!, 'REJECT', { reason: o.reason, diff, warnings: o.warnings });
    await emitDecided(tx, actor, row!, 'REJECTED');
    return { outcome: 'REJECTED', deferred: false };
  }

  const problems = await d.validate(tx, p);
  if (problems.length) {
    approvalTransition(p.status, 'BLOCK');
    const blockedReason = problems.map((x) => x.message).join(' ');
    const [row] = await tx
      .update(approvalProposals)
      .set({ status: 'BLOCKED', decidedAt: o.now, decidedBy, decisionReason: o.reason, blockedReason, warnings: [...o.warnings], updatedAt: o.now })
      .where(eq(approvalProposals.id, p.id))
      .returning();
    await recordDecision(tx, actor, row!, 'BLOCK', { reason: blockedReason, diff, warnings: o.warnings, bulkBatchId: o.bulkBatchId, audit: { problems } });
    await emitDecided(tx, actor, row!, 'BLOCKED');
    return { outcome: 'BLOCKED', deferred: false };
  }

  approvalTransition(p.status, kind);
  const [approved] = await tx
    .update(approvalProposals)
    .set({
      status: 'APPROVED',
      decidedAt: o.now,
      decidedBy,
      decisionReason: o.reason,
      dependencyHash: o.dependencyHash,
      warnings: [...o.warnings],
      updatedAt: o.now,
    })
    .where(eq(approvalProposals.id, p.id))
    .returning();
  await recordDecision(tx, actor, approved!, kind, { reason: o.reason, diff, warnings: o.warnings, bulkBatchId: o.bulkBatchId });
  const activation = await d.activate(tx, actor, approved!);
  if (activation.kind === 'DONE') {
    const [activated] = await tx.update(approvalProposals).set({ activatedAt: o.now, updatedAt: o.now }).where(eq(approvalProposals.id, p.id)).returning();
    await recordDecision(tx, actor, activated!, 'ACTIVATE', { bulkBatchId: o.bulkBatchId });
  }
  await emitDecided(tx, actor, approved!, 'APPROVED');
  return { outcome: 'APPROVED', deferred: activation.kind === 'DEFERRED' };
}
