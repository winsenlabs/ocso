import { DomainError } from '../errors/domain-error.js';

/**
 * Maker–checker state machine (PM/research/11 §4, 11b). Pure and browser-safe:
 * the API enforces it, the web app uses it to label rows.
 */
export const APPROVAL_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'BLOCKED', 'VOID'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'ACTIVATE'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_DECISION_KINDS = [
  'SUBMIT',
  'EDIT',
  'APPROVE',
  'BOOTSTRAP_APPROVE',
  'REJECT',
  'WITHDRAW',
  'REASSIGN',
  'BLOCK',
  'VOID',
  'ACTIVATE',
] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];

/** What an event does to the proposal's status; anything not listed is illegal. ACTIVATE finishes a deferred approval. */
const TRANSITIONS: Readonly<Record<ApprovalStatus, Partial<Record<ApprovalDecisionKind, ApprovalStatus>>>> = {
  SUBMITTED: {
    EDIT: 'SUBMITTED',
    REASSIGN: 'SUBMITTED',
    WITHDRAW: 'WITHDRAWN',
    REJECT: 'REJECTED',
    APPROVE: 'APPROVED',
    BOOTSTRAP_APPROVE: 'APPROVED',
    BLOCK: 'BLOCKED',
    VOID: 'VOID',
  },
  APPROVED: { ACTIVATE: 'APPROVED', BLOCK: 'BLOCKED' },
  REJECTED: {},
  WITHDRAWN: {},
  BLOCKED: {},
  VOID: {},
};

export class InvalidApprovalTransitionError extends DomainError {
  constructor(from: ApprovalStatus, event: ApprovalDecisionKind) {
    super('conflict', 'approval_invalid_transition', `A ${from.toLowerCase()} proposal cannot take ${event.toLowerCase()}`, { from, event });
  }
}

export function approvalTransition(from: ApprovalStatus, event: ApprovalDecisionKind): ApprovalStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidApprovalTransitionError(from, event);
  return to;
}

/** Only a submitted proposal is open: it locks its object and waits for a decision. */
export const isApprovalOpen = (status: ApprovalStatus): boolean => status === 'SUBMITTED';

export type ApprovalWarningCode =
  | 'content_changed'
  | 'dependency_changed'
  | 'edited_after_submission'
  | 'validation_failed'
  | 'checker_invalid'
  | 'self_review'
  | 'object_missing'
  | 'aged';

export interface ApprovalWarning {
  code: ApprovalWarningCode;
  message: string;
  /** A warning that blocks bulk approval: the proposal must be opened on its own. */
  blocksBulk: boolean;
}

/** Every warning except age blocks bulk approval. */
export const BULK_BLOCKING: ReadonlySet<ApprovalWarningCode> = new Set<ApprovalWarningCode>([
  'content_changed',
  'dependency_changed',
  'edited_after_submission',
  'validation_failed',
  'checker_invalid',
  'self_review',
  'object_missing',
]);
