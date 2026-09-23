import { onDirectRightsChange, type IdentityApprovals, type IdentityGovernance } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';

/** How user and permission increases reach maker–checker (`IdentityGovernance`). */
export const IDENTITY_GOVERNANCE = Symbol('IDENTITY_GOVERNANCE');
/**
 * The approval spine's submit port (`IdentityApprovals | null`): the adapter over
 * ApprovalService.submit (createIdentityApprovals, PM/research/11 §3.4). Null
 * only where no spine is wired: every increase then answers 409 approval_required.
 */
export const IDENTITY_APPROVALS = Symbol('IDENTITY_APPROVALS');

/** Development and test deployments may skip access approval; production never (also refused at start-up). */
export function identityGovernance(
  env: Pick<ApiEnv, 'NODE_ENV' | 'OCSO_DEV_SKIP_ACCESS_APPROVAL'>,
  approvals: IdentityApprovals | null,
  warn: (message: string) => void = () => undefined,
): IdentityGovernance {
  const skipAccessApproval = env.NODE_ENV !== 'production' && env.OCSO_DEV_SKIP_ACCESS_APPROVAL === true;
  if (skipAccessApproval) warn('OCSO_DEV_SKIP_ACCESS_APPROVAL is on: new users and access increases apply without approval (audited as approvalSkipped: dev_flag)');
  // onDirectRightsChange: a pending user's draft waits while its creation proposal is open; discarding voids it.
  return { approvals, skipAccessApproval, skipReason: 'dev_flag', onDirectRightsChange };
}
