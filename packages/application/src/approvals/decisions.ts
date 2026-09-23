import { eq } from 'drizzle-orm';
import { Permission, assertCan, can, type Principal } from '@ocso/auth';
import { approvalProposals, uuidv7, type DbOrTx } from '@ocso/db';
import { DomainError, ErrorCategory, approvalTransition, conflict, forbidden, isDomainError, notFound, validation, type ApprovalWarningCode } from '@ocso/domain';
import { TOPICS } from '@ocso/queue';
import type { ActorContext } from '../shared/context.js';
import { isEligibleChecker, loadPerson } from './access.js';
import { applyDecision, type DecisionOutcome } from './activation.js';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';
import type { ApprovalDecisionInput, BulkDecisionInput, ReassignInput } from './inputs.js';
import { ApprovalReader } from './queries.js';
import { lockFor } from './guard.js';
import { emitDecided, emitRequested, recordDecision } from './records.js';
import { finishDeferredActivation, type FinishOutcome } from './deferred.js';
import { assessProposal } from './warnings.js';
import type { ProposalDetail } from './views.js';

export type BulkSkipCode = ApprovalWarningCode | 'not_open' | 'not_checker';

export interface BulkDecisionResult {
  batchId: string;
  approved: string[];
  skipped: Array<{ id: string; code: BulkSkipCode; message: string }>;
}

const SKIP_CODES: ReadonlySet<string> = new Set<BulkSkipCode>([
  'content_changed',
  'dependency_changed',
  'edited_after_submission',
  'validation_failed',
  'checker_invalid',
  'self_review',
  'object_missing',
  'aged',
  'not_open',
  'not_checker',
]);

const decisionError = (code: string, message: string): DomainError => new DomainError(ErrorCategory.AUTHORIZATION, code, message);

interface DecideOptions {
  bulk?: { batchId: string } | undefined;
}

/**
 * Checker side of the approval spine (PM/research/11b "Evaluation order at
 * decision"): decide, bulk approve, reassign, and finishing deferred
 * activations in the worker. Deciding requires being the named checker —
 * approvals.reassign_any lets someone reassign, never decide.
 */
export class ApprovalDecisionService extends ApprovalReader {
  async decide(actor: ActorContext, id: string, input: ApprovalDecisionInput): Promise<ProposalDetail> {
    const principal = actor.principal!;
    const p0 = await this.load(principal, id);
    const d = this.registry.get(p0.objectKind);
    const out = await this.db.transaction((tx) => this.decideOne(tx, actor, d, id, input));
    await this.afterDecision(id, out);
    return this.get(principal, id);
  }

  async bulkDecide(actor: ActorContext, input: BulkDecisionInput): Promise<BulkDecisionResult> {
    const principal = actor.principal!;
    const result: BulkDecisionResult = { batchId: uuidv7(), approved: [], skipped: [] };
    for (const item of input.items) {
      try {
        const p0 = await this.load(principal, item.id);
        const d = this.registry.get(p0.objectKind);
        const input1 = { decision: 'APPROVE' as const, reason: input.reason, contentHash: item.contentHash };
        const out = await this.db.transaction((tx) => this.decideOne(tx, actor, d, item.id, input1, { bulk: { batchId: result.batchId } }));
        await this.afterDecision(item.id, out);
        if (out.outcome === 'APPROVED') result.approved.push(item.id);
        else result.skipped.push({ id: item.id, code: 'validation_failed', message: 'The change no longer passes validation' });
      } catch (err) {
        if (!isDomainError(err)) throw err;
        const code = SKIP_CODES.has(err.code) ? (err.code as BulkSkipCode) : err.category === 'not_found' ? 'not_open' : 'not_checker';
        result.skipped.push({ id: item.id, code, message: err.message });
      }
    }
    return result;
  }

  async reassign(actor: ActorContext, id: string, input: ReassignInput): Promise<ProposalDetail> {
    const principal = actor.principal!;
    const p0 = await this.load(principal, id);
    const d = this.registry.get(p0.objectKind);
    this.assertMayReassign(principal, d);
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const p = await lockOpen(tx, id);
      await d.assertVisible(tx, principal, p.objectId);
      if (input.checkerId === p.makerId || !(await isEligibleChecker(tx, d, p, await loadPerson(tx, input.checkerId)))) {
        throw validation('checker_not_eligible', 'The new checker must be active, hold the approval permission for this kind, share a team with it, and not be the maker');
      }
      const [row] = await tx
        .update(approvalProposals)
        .set({ checkerId: input.checkerId, checkerValid: true, notifiedAt: null, updatedAt: now })
        .where(eq(approvalProposals.id, id))
        .returning();
      await recordDecision(tx, actor, row!, 'REASSIGN', { reason: input.reason, audit: { previousCheckerId: p.checkerId } });
      await emitRequested(tx, actor, row!);
    });
    await this.publish(TOPICS.APPROVAL_NOTIFY, { proposalId: id, kind: 'REQUESTED' }, `approval-notify:${id}:reassigned:${now.getTime()}`);
    return this.get(principal, id);
  }

  /**
   * An open proposal nobody can decide any more (the maker left, the object drifted and the maker is away) is
   * voided by a holder of approvals.reassign_any, with a reason: a VOID decision row and an audit event. The
   * object is unlocked; nothing is applied.
   */
  async voidProposal(actor: ActorContext, id: string, reason: string): Promise<ProposalDetail> {
    const principal = actor.principal!;
    assertCan(principal, Permission.APPROVALS_REASSIGN_ANY);
    await this.load(principal, id);
    await this.db.transaction(async (tx) => {
      const p = await lockOpen(tx, id);
      await voidOpen(tx, actor, p, reason, this.now(), principal.userId);
    });
    await this.publish(TOPICS.APPROVAL_NOTIFY, { proposalId: id, kind: 'DECIDED' }, `approval-notify:${id}:decided:VOID`);
    return this.get(principal, id);
  }

  /** Worker: finishes a DEFERRED activation. Re-validates and re-checks both hashes first. */
  finishActivation(actor: ActorContext, proposalId: string): Promise<FinishOutcome> {
    return finishDeferredActivation(this.db, this.registry, actor, proposalId, { now: () => this.now(), notify: (id) => this.afterDecision(id, { outcome: 'BLOCKED', deferred: false }) });
  }

  private async afterDecision(id: string, out: { outcome: DecisionOutcome; deferred: boolean }): Promise<void> {
    await this.publish(TOPICS.APPROVAL_NOTIFY, { proposalId: id, kind: 'DECIDED' }, `approval-notify:${id}:decided:${out.outcome}`);
    if (out.deferred) await this.publish(TOPICS.APPROVAL_ACTIVATE, { proposalId: id }, `approval-activate:${id}`);
  }

  /**
   * The checks, then the decision, in one transaction. Lock order: the proposal row, then the object's lock
   * (the one submit and the direct write paths take), so nothing can change the object between the checks
   * below and the activation.
   */
  private async decideOne(tx: DbOrTx, actor: ActorContext, d: ApprovalDescriptor, id: string, input: ApprovalDecisionInput, o: DecideOptions = {}) {
    const principal = actor.principal!;
    const p = await lockOpen(tx, id);
    await lockFor(tx, d, p.objectId);
    // Rights and eligibility are re-read from the database at decision time: a checker disabled, stripped of the
    // permission or moved out of the owning teams since submit cannot decide (the sweep only flags; this enforces).
    // Being the named, still-eligible checker is what lets them see the object's projection here.
    const fresh = await loadPerson(tx, principal.userId);
    assertMayDecide(fresh ?? { ...principal, permissions: new Set() }, d, p);
    if (!p.checkerValid || !(await isEligibleChecker(tx, d, p, fresh))) {
      throw decisionError('checker_invalid', 'You can no longer approve this change; it needs a new checker.');
    }
    const a = await assessProposal(tx, d, p, { viewer: principal, now: this.now(), ageThresholdHours: await this.ageThresholdHours() });
    // Rejecting stale content is always safe, so a reject never needs matching hashes (a drifted proposal can
    // always be closed). Approving needs both: exactly the bytes the checker saw, against the dependencies stored
    // at submit (PM/research/11b) — the maker refreshes a drifted proposal by editing it.
    if (input.decision === 'APPROVE') {
      if (input.contentHash !== p.contentHash || a.liveContentHash !== p.contentHash) {
        throw new DomainError(ErrorCategory.CONFLICT, 'content_changed', 'This proposal changed since you opened it. Reload it and review the change again.', { contentHash: p.contentHash });
      }
      if (a.liveDependencyHash !== p.dependencyHash || (input.dependencyHash !== undefined && input.dependencyHash !== p.dependencyHash)) {
        throw new DomainError(ErrorCategory.CONFLICT, 'dependency_changed', 'Something this change relies on was edited after it was submitted. Ask the maker to refresh it (edit and resubmit).', {
          dependencyHash: a.liveDependencyHash,
        });
      }
    }
    if (o.bulk) {
      const blocking = a.warnings.find((w) => w.blocksBulk);
      if (blocking) throw new DomainError(ErrorCategory.CONFLICT, blocking.code, blocking.message);
    }
    return applyDecision(tx, d, actor, p, input.decision === 'REJECT' ? 'REJECT' : 'APPROVE', {
      reason: input.reason?.trim() || null,
      now: this.now(),
      warnings: a.warnings,
      dependencyHash: p.dependencyHash,
      bulkBatchId: o.bulk?.batchId,
    });
  }
}

/** Rules 3–5: holds the check permission, is not the maker, is the named checker. */
export function assertMayDecide(principal: Principal, d: ApprovalDescriptor, p: ProposalRow): void {
  if (!can(principal, d.checkPermission)) throw forbidden(d.checkPermission, `${principal.displayName} cannot approve ${d.label} changes`);
  if (principal.userId === p.makerId) throw decisionError('self_review', 'You made this change, so someone else must approve it');
  if (principal.userId !== p.checkerId) throw decisionError('not_checker', 'Only the named checker can decide this proposal');
}

/** VOID an open, locked proposal (admin void, or the sweep for a maker who is gone). */
export async function voidOpen(tx: DbOrTx, actor: ActorContext, p: ProposalRow, reason: string, now: Date, decidedBy: string | null): Promise<ProposalRow> {
  approvalTransition(p.status, 'VOID');
  const [row] = await tx
    .update(approvalProposals)
    .set({ status: 'VOID', decidedAt: now, decidedBy, decisionReason: reason, updatedAt: now })
    .where(eq(approvalProposals.id, p.id))
    .returning();
  await recordDecision(tx, actor, row!, 'VOID', { reason });
  await emitDecided(tx, actor, row!, 'VOID');
  return row!;
}

export async function lockOpen(tx: DbOrTx, id: string): Promise<ProposalRow> {
  const [p] = await tx.select().from(approvalProposals).where(eq(approvalProposals.id, id)).for('update');
  if (!p) throw notFound('approval', id);
  if (p.status !== 'SUBMITTED') throw conflict('not_open', 'This proposal has already been decided');
  return p;
}
