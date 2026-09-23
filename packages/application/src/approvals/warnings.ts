import type { Principal } from '@ocso/auth';
import type { DbOrTx } from '@ocso/db';
import { BULK_BLOCKING, type ApprovalWarning, type ApprovalWarningCode } from '@ocso/domain';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from './contract.js';
import { contentBasisOf, dependencyHashOf, proposalContentHash, snapshotOf, type Snapshot } from './hashing.js';

/**
 * Warnings on an open proposal (PM/research/11b). Every warning except `aged`
 * blocks bulk approval: the checker must open that proposal on its own.
 */

const MESSAGES: Record<ApprovalWarningCode, string> = {
  content_changed: 'The object changed since this was submitted. Ask the maker to refresh the proposal.',
  dependency_changed: 'Something this change relies on was edited since it was submitted. Review it again.',
  edited_after_submission: 'The maker edited this proposal after submitting it.',
  validation_failed: 'The change no longer passes validation.',
  checker_invalid: 'The named checker can no longer approve this. It needs a new checker.',
  self_review: 'You made this change, so you cannot approve it.',
  object_missing: 'The object no longer exists.',
  aged: 'Waiting longer than the approval age threshold.',
};

export function warning(code: ApprovalWarningCode, message: string = MESSAGES[code]): ApprovalWarning {
  return { code, message, blocksBulk: BULK_BLOCKING.has(code) };
}

export interface WarningFacts {
  objectExists: boolean;
  liveContentHash: string;
  storedContentHash: string;
  liveDependencyHash: string;
  storedDependencyHash: string;
  editedAfterSubmission: boolean;
  problems: readonly ApprovalProblem[];
  checkerValid: boolean;
  /** The viewer is both maker and named checker (only a bootstrap could be). */
  selfReview: boolean;
  ageHours: number;
  ageThresholdHours: number;
}

/** Pure: which warnings these facts raise, in a stable order. */
export function warningsFrom(f: WarningFacts): ApprovalWarning[] {
  const out: ApprovalWarning[] = [];
  if (!f.objectExists) out.push(warning('object_missing'));
  else if (f.liveContentHash !== f.storedContentHash) out.push(warning('content_changed'));
  if (f.liveDependencyHash !== f.storedDependencyHash) out.push(warning('dependency_changed'));
  if (f.editedAfterSubmission) out.push(warning('edited_after_submission'));
  if (f.problems.length) out.push(warning('validation_failed', f.problems.map((p) => p.message).join(' ')));
  if (!f.checkerValid) out.push(warning('checker_invalid'));
  if (f.selfReview) out.push(warning('self_review'));
  if (f.ageHours >= f.ageThresholdHours) out.push(warning('aged', `Waiting ${Math.floor(f.ageHours)} h (threshold ${f.ageThresholdHours} h).`));
  return out;
}

export interface Assessment {
  /** The object's projection now. */
  liveBefore: Snapshot;
  liveContentHash: string;
  liveDependencyHash: string;
  problems: readonly ApprovalProblem[];
  warnings: ApprovalWarning[];
}

/** Recompute everything a decision depends on, from the live rows. */
export async function assessProposal(
  tx: DbOrTx,
  d: ApprovalDescriptor,
  p: ProposalRow,
  opts: { viewer: Principal | null; now: Date; ageThresholdHours: number },
): Promise<Assessment> {
  const liveBefore = snapshotOf(await d.project(tx, p.objectId));
  const liveContentHash = proposalContentHash({ ...p, beforeSnapshot: await contentBasisOf(tx, d, p.objectId, liveBefore) }, d.hashExclude);
  const liveDependencyHash = dependencyHashOf(liveBefore ? await d.dependencies(tx, p) : []);
  const problems = liveBefore ? await d.validate(tx, p) : [{ code: 'object_missing', message: 'The object no longer exists.' }];
  const warnings = warningsFrom({
    objectExists: liveBefore !== null,
    liveContentHash,
    storedContentHash: p.contentHash,
    liveDependencyHash,
    storedDependencyHash: p.dependencyHash,
    editedAfterSubmission: p.editedAfterSubmission,
    problems,
    checkerValid: p.checkerValid,
    selfReview: opts.viewer !== null && opts.viewer.userId === p.makerId && opts.viewer.userId === p.checkerId,
    ageHours: (opts.now.getTime() - p.submittedAt.getTime()) / 3_600_000,
    ageThresholdHours: opts.ageThresholdHours,
  });
  return { liveBefore, liveContentHash, liveDependencyHash, problems, warnings };
}
