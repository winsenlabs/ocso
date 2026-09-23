import { z } from 'zod';

/**
 * Response contracts of /v1/approvals (PM/research/11b "View shapes"),
 * client-safe so screens and the API wrappers share them. A proposal's
 * payload is never sent to the browser.
 */
export const APPROVAL_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'BLOCKED', 'VOID'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'ACTIVATE'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

const Person = z.object({ id: z.string(), name: z.string() });
export const WarningSchema = z.object({ code: z.string(), message: z.string(), blocksBulk: z.boolean() });
export type ApprovalWarning = z.infer<typeof WarningSchema>;
export const DiffFieldSchema = z.object({ path: z.string(), before: z.unknown(), after: z.unknown(), change: z.enum(['added', 'removed', 'changed']) });
export type DiffField = z.infer<typeof DiffFieldSchema>;

export const ProposalListItemSchema = z.object({
  id: z.string(),
  objectKind: z.string(),
  objectLabel: z.string(),
  objectId: z.string(),
  action: z.enum(APPROVAL_ACTIONS),
  status: z.enum(APPROVAL_STATUSES),
  origin: z.string(),
  activating: z.boolean(),
  bootstrap: z.boolean(),
  title: z.string(),
  reason: z.string(),
  revision: z.number(),
  maker: Person.nullable(),
  checker: Person.nullable(),
  checkerValid: z.boolean(),
  submittedAt: z.string(),
  decidedAt: z.string().nullable(),
  ageSeconds: z.number(),
  warnings: z.array(WarningSchema),
  contentHash: z.string(),
  dependencyHash: z.string(),
  changedFields: z.array(z.string()),
});
export type ProposalListItem = z.infer<typeof ProposalListItemSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  revision: z.number(),
  actor: Person.nullable(),
  actorName: z.string(),
  reason: z.string().nullable(),
  contentHash: z.string(),
  bulkBatchId: z.string().nullable(),
  occurredAt: z.string(),
});
export type ApprovalDecision = z.infer<typeof DecisionSchema>;

const Snapshot = z.record(z.string(), z.unknown()).nullable();
export const ProposalDetailSchema = ProposalListItemSchema.extend({
  diff: z.array(DiffFieldSchema),
  before: Snapshot,
  after: Snapshot,
  liveBefore: Snapshot,
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
  decisions: z.array(DecisionSchema),
  decisionReason: z.string().nullable(),
  decidedBy: Person.nullable(),
  blockedReason: z.string().nullable(),
  activatedAt: z.string().nullable(),
  canDecide: z.boolean(),
  canEdit: z.boolean(),
  canWithdraw: z.boolean(),
  canReassign: z.boolean(),
  canVoid: z.boolean().default(false),
});
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;

export const ApprovalPageSchema = z.object({
  rows: z.array(ProposalListItemSchema),
  next: z.object({ before: z.string(), beforeId: z.string() }).nullable(),
});
export type ApprovalPage = z.infer<typeof ApprovalPageSchema>;

export const ApprovalCountsSchema = z.object({ awaitingMe: z.number(), sentByMe: z.number(), open: z.number(), needsChecker: z.number() });
export type ApprovalCounts = z.infer<typeof ApprovalCountsSchema>;

export const ApprovalKindSchema = z.object({ kind: z.string(), label: z.string(), actions: z.array(z.string()), checkPermission: z.string() });
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const CheckerChoiceSchema = z.object({
  /** email and role are null unless the viewer holds users.read (the staff directory stays behind it). */
  checkers: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), role: z.string().nullable() })),
  bootstrapAllowed: z.boolean(),
  checkPermission: z.string(),
});
export type CheckerChoice = z.infer<typeof CheckerChoiceSchema>;

export const ProposalRefSchema = z.object({
  id: z.string(),
  action: z.enum(APPROVAL_ACTIONS),
  status: z.enum(APPROVAL_STATUSES),
  checkerId: z.string().nullable(),
  checkerName: z.string().nullable(),
  makerId: z.string().nullable(),
  submittedAt: z.string(),
  activating: z.boolean(),
});
export type ProposalRef = z.infer<typeof ProposalRefSchema>;

/** GET /v1/approvals/state, and `approval` on an agent. */
export const ObjectApprovalStateSchema = z.object({
  approved: z.boolean(),
  pending: ProposalRefSchema.nullable(),
  updateNeedsApproval: z.boolean(),
  checkPermission: z.string(),
});
export type ObjectApprovalState = z.infer<typeof ObjectApprovalStateSchema>;

/** A write endpoint that became a proposal answers 202 `{ proposal }`. */
export const ProposedSchema = z.object({ proposal: ProposalListItemSchema });
