import type { ExceptionKind } from './contract.js';
import { approvalsAged, bootstrapApprovals, liveWithoutApproval, resubmittedUnchanged } from './kinds/approvals.js';
import { auditChain, auditShipping } from './kinds/audit.js';
import { changedOutsideApproval, installedOnly } from './kinds/drift.js';
import { deliveryFailures, permissionBypass, routingFallback, templatesRejected } from './kinds/operations.js';
import { reportHygiene } from './kinds/reporting.js';

/**
 * Every check the exception report runs (PM/research/11 §7), in report order.
 * Kinds are ids of checks, not object kinds: live_without_approval walks the
 * approval registry, so a new approvable kind is covered without a change here.
 */
export const EXCEPTION_KINDS: readonly ExceptionKind[] = [
  liveWithoutApproval,
  permissionBypass,
  changedOutsideApproval,
  auditChain,
  auditShipping,
  bootstrapApprovals,
  resubmittedUnchanged,
  approvalsAged,
  deliveryFailures,
  routingFallback,
  templatesRejected,
  reportHygiene,
  installedOnly,
];

export const EXCEPTION_KIND_IDS: readonly string[] = EXCEPTION_KINDS.map((k) => k.id);
