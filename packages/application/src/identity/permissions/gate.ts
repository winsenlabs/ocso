import { DomainError, ErrorCategory, validation } from '@ocso/domain';
import type { DbOrTx } from '@ocso/db';
import type { ActorContext } from '../../shared/context.js';
import type { ApprovalChoice } from './change-set.js';

/**
 * How increases to someone's rights reach maker–checker (PM/research/11 §3.4,
 * §4.1). Decreases never come here: stopping is never gated.
 *
 * The approval spine plugs in through `IdentityApprovals` (wave 2 adapts
 * ApprovalService.submit and registers the `user` and `permission_change`
 * descriptors, whose activate() calls activateUser / applyPermissionChangeSet).
 * Until it is wired, every increase answers 409 approval_required.
 */
export type IdentityObjectKind = 'user' | 'permission_change';
export type IdentityAction = 'CREATE' | 'UPDATE' | 'ACTIVATE';

export interface IdentityProposalRequest {
  objectKind: IdentityObjectKind;
  /** The target user's id for both kinds. */
  objectId: string;
  action: IdentityAction;
  /** What approval applies: a PermissionChangeSet for permission_change, `{ userId }` for user. */
  payload: Record<string, unknown>;
  approval: ApprovalChoice;
  reason: string;
}

/** The proposal as the write endpoints return it (202). */
export interface IdentityProposalRef {
  id: string;
  objectKind: IdentityObjectKind;
  objectId: string;
  action: IdentityAction;
  status: string;
  checkerId: string | null;
  bootstrap: boolean;
}

/**
 * The approval spine's submit port. Contract for the adapter (wave 2):
 * - the checker must be eligible (§3.4: holds approvals.check.permissions, is
 *   ACTIVE, shares a team with the target or holds users.manage) and is never
 *   the maker nor the target user — proposeIncrease already refuses the last two;
 * - `{bootstrap:true}` is accepted only when no eligible checker other than the
 *   maker and the target exists AND the maker holds approvals.check.permissions
 *   (§4.2); it is recorded BOOTSTRAP_APPROVE;
 * - it runs outside the caller's transaction (the caller has committed), because
 *   an immediate (bootstrap) approval applies the change under the user's row lock.
 */
export interface IdentityApprovals {
  submit(actor: ActorContext, request: IdentityProposalRequest): Promise<IdentityProposalRef>;
}

/** What an increase needs before it can apply: returned in the 409 so the client can submit it. */
export interface ApprovalRequirement {
  objectKind: IdentityObjectKind;
  action: IdentityAction;
  objectId: string;
}

export function approvalRequired(requirement: ApprovalRequirement, message = 'This change increases access and needs approval: name a checker'): DomainError {
  return new DomainError(ErrorCategory.CONFLICT, 'approval_required', message, { ...requirement });
}

export interface IdentityGovernance {
  approvals?: IdentityApprovals | null | undefined;
  /**
   * Development and test deployments only (OCSO_DEV_SKIP_ACCESS_APPROVAL; refused
   * when NODE_ENV=production): new users are created ACTIVE, and preset upgrades,
   * re-enabling and team additions apply at once. Per-user grants always need approval.
   */
  skipAccessApproval?: boolean | undefined;
  /** Why approval is skipped; recorded as `approvalSkipped` on every audit row that skipped it (exception report). */
  skipReason?: ApprovalSkipReason | undefined;
  /**
   * Called inside the write's transaction, after the target user's row is
   * locked, before any direct change to that user's rights (a reduction, a
   * draft edit of a pending user, a team change) or the discard of a pending
   * user. Wave 2 plugs the "edit voids approval" rule in here: void (or refuse
   * while open) the user's `user` / `permission_change` proposals.
   */
  onDirectRightsChange?: ((tx: DbOrTx, actor: ActorContext, event: { userId: string; kind: 'rights' | 'discard' }) => Promise<void>) | undefined;
}

export type ApprovalSkipReason = 'dev_flag' | 'demo_seed';

/** The audit marker of a skipped approval (null when approval was not skipped). */
export function skipMarker(governance: IdentityGovernance): ApprovalSkipReason | null {
  return governance.skipAccessApproval ? (governance.skipReason ?? 'dev_flag') : null;
}

/**
 * Route an increase: to the approval spine when the maker named a checker (or
 * bootstrap) and the spine is wired, otherwise 409 approval_required. Never applies.
 */
export async function proposeIncrease(
  governance: IdentityGovernance,
  actor: ActorContext,
  request: Omit<IdentityProposalRequest, 'approval'> & { approval?: ApprovalChoice | undefined },
): Promise<IdentityProposalRef> {
  const { objectKind, action, objectId } = request;
  if (!request.approval) throw approvalRequired({ objectKind, action, objectId });
  if ('checkerId' in request.approval) {
    const checkerId = request.approval.checkerId;
    if (checkerId === actor.principal?.userId) throw validation('checker_not_eligible', 'You cannot check your own proposal: name a colleague');
    if (checkerId === objectId) throw validation('checker_not_eligible', 'The person whose access changes cannot approve it');
  }
  if (!governance.approvals) {
    throw approvalRequired({ objectKind, action, objectId }, 'This change increases access and needs approval, which is not available on this deployment yet');
  }
  return governance.approvals.submit(actor, { ...request, approval: request.approval });
}
