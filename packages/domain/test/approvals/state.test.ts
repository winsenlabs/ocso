import { describe, expect, it } from 'vitest';
import { APPROVAL_DECISION_KINDS, APPROVAL_STATUSES, BULK_BLOCKING, InvalidApprovalTransitionError, approvalTransition, isApprovalOpen, type ApprovalStatus } from '../../src/index.js';

describe('approval state machine', () => {
  it('allows exactly the documented transitions', () => {
    const legal: Array<[ApprovalStatus, (typeof APPROVAL_DECISION_KINDS)[number], ApprovalStatus]> = [
      ['SUBMITTED', 'EDIT', 'SUBMITTED'],
      ['SUBMITTED', 'REASSIGN', 'SUBMITTED'],
      ['SUBMITTED', 'WITHDRAW', 'WITHDRAWN'],
      ['SUBMITTED', 'REJECT', 'REJECTED'],
      ['SUBMITTED', 'APPROVE', 'APPROVED'],
      ['SUBMITTED', 'BOOTSTRAP_APPROVE', 'APPROVED'],
      ['SUBMITTED', 'BLOCK', 'BLOCKED'],
      ['SUBMITTED', 'VOID', 'VOID'],
      ['APPROVED', 'ACTIVATE', 'APPROVED'],
      ['APPROVED', 'BLOCK', 'BLOCKED'],
    ];
    for (const [from, event, to] of legal) expect(approvalTransition(from, event)).toBe(to);
    let illegal = 0;
    for (const from of APPROVAL_STATUSES) {
      for (const event of APPROVAL_DECISION_KINDS) {
        if (legal.some(([f, e]) => f === from && e === event)) continue;
        expect(() => approvalTransition(from, event)).toThrow(InvalidApprovalTransitionError);
        illegal++;
      }
    }
    expect(illegal).toBe(APPROVAL_STATUSES.length * APPROVAL_DECISION_KINDS.length - legal.length);
  });

  it('never approves twice, and terminal statuses accept nothing', () => {
    expect(() => approvalTransition('APPROVED', 'APPROVE')).toThrow(InvalidApprovalTransitionError);
    for (const terminal of ['REJECTED', 'WITHDRAWN', 'BLOCKED', 'VOID'] as const) {
      for (const event of APPROVAL_DECISION_KINDS) expect(() => approvalTransition(terminal, event)).toThrow();
    }
  });

  it('only SUBMITTED is open; every warning but age blocks bulk approval', () => {
    expect(APPROVAL_STATUSES.filter(isApprovalOpen)).toEqual(['SUBMITTED']);
    expect([...BULK_BLOCKING].sort()).toEqual(['checker_invalid', 'content_changed', 'dependency_changed', 'edited_after_submission', 'object_missing', 'self_review', 'validation_failed']);
    expect(BULK_BLOCKING.has('aged')).toBe(false);
  });
});
