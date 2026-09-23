import { APPROVAL_ACTIONS, APPROVAL_STATUSES } from '@ocso/domain';
import { z } from 'zod';
import { patchOf } from '../shared/patch.js';

const Reason = z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500);
const Hash = z.string().min(8).max(64);

/**
 * What an approvable write endpoint accepts beside its own body (PM/research/11 §4.1):
 * a named checker and the maker's reason, or — only when nobody else could
 * check it and the maker holds the check permission — a bootstrap approval.
 */
export const ApprovalRequest = z.union([
  z.object({ checkerId: z.uuid(), reason: Reason }),
  z.object({ bootstrap: z.literal(true), reason: Reason.optional() }),
]);
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** `{ approval?: ApprovalRequest }`, for extending an endpoint's body schema. */
export const WithApproval = z.object({ approval: ApprovalRequest.optional() });

const SubmitFields = z.object({
  objectKind: z.string().trim().min(1).max(60),
  objectId: z.uuid(),
  action: z.enum(APPROVAL_ACTIONS),
  checkerId: z.uuid().optional(),
  /** Approve my own proposal: allowed only when no other eligible checker exists (BOOTSTRAP_APPROVE). */
  bootstrap: z.literal(true).optional(),
  reason: Reason,
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const ApprovalSubmitInput = SubmitFields.superRefine((v, ctx) => {
  if (!v.checkerId === !v.bootstrap) ctx.addIssue({ code: 'custom', path: ['checkerId'], message: 'Name a checker, or ask for a bootstrap approval' });
});
export type ApprovalSubmitInput = z.input<typeof ApprovalSubmitInput>;

/** The maker edits the proposal (never the locked object): revision+1, marked edited. */
export const ApprovalEditInput = patchOf(SubmitFields).pick({ checkerId: true, reason: true, payload: true });
export type ApprovalEditInput = z.infer<typeof ApprovalEditInput>;

export const ApprovalWithdrawInput = z.object({ reason: Reason });

export const ApprovalDecisionInput = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    /** Required to reject; optional to approve. */
    reason: z.string().trim().max(500).optional(),
    /** The content hash the checker was shown; a mismatch is 409 content_changed. */
    contentHash: Hash,
    /** The dependency hash the checker was shown (defaults to the one stored at submit); a mismatch is 409 dependency_changed. */
    dependencyHash: Hash.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'REJECT' && (v.reason ?? '').length < 3) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Give a reason of at least 3 characters to reject' });
  });
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;

export const BULK_APPROVE_MAX = 50;
export const BulkDecisionInput = z.object({
  decision: z.literal('APPROVE'),
  reason: Reason,
  items: z.array(z.object({ id: z.uuid(), contentHash: Hash })).min(1).max(BULK_APPROVE_MAX),
});
export type BulkDecisionInput = z.infer<typeof BulkDecisionInput>;

export const ReassignInput = z.object({ checkerId: z.uuid(), reason: Reason });
export type ReassignInput = z.infer<typeof ReassignInput>;

export const APPROVAL_BOXES = ['AWAITING_ME', 'SENT_BY_ME', 'OPEN', 'DECIDED'] as const;
export type ApprovalBox = (typeof APPROVAL_BOXES)[number];

export const ApprovalQuery = z.object({
  box: z.enum(APPROVAL_BOXES).default('AWAITING_ME'),
  objectKind: z.string().max(60).optional(),
  status: z.enum(APPROVAL_STATUSES).optional(),
  makerId: z.uuid().optional(),
  checkerId: z.uuid().optional(),
  /** Only open proposals whose checker lost their rights ("Needs a new checker"). */
  needsChecker: z.stringbool().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ApprovalQuery = z.infer<typeof ApprovalQuery>;

export const ApprovalObjectQuery = z.object({ objectKind: z.string().trim().min(1).max(60), objectId: z.uuid() });
export type ApprovalObjectQuery = z.infer<typeof ApprovalObjectQuery>;
