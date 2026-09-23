import { approvalDecisions, uuidv7, type DbOrTx } from '@ocso/db';
import { diffFields, type ApprovalDecisionKind, type ApprovalWarning, type DiffField } from '@ocso/domain';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import type { ProposalRow } from './contract.js';

/** Audit action per decision kind (target_type 'approval'). */
const AUDIT_ACTION: Record<ApprovalDecisionKind, string> = {
  SUBMIT: 'approval.submit',
  EDIT: 'approval.edit',
  APPROVE: 'approval.approve',
  BOOTSTRAP_APPROVE: 'approval.bootstrap_approve',
  REJECT: 'approval.reject',
  WITHDRAW: 'approval.withdraw',
  REASSIGN: 'approval.reassign',
  BLOCK: 'approval.block',
  VOID: 'approval.void',
  ACTIVATE: 'approval.activate',
};

const VERB: Record<ApprovalDecisionKind, string> = {
  SUBMIT: 'Submitted',
  EDIT: 'Edited',
  APPROVE: 'Approved',
  BOOTSTRAP_APPROVE: 'Approved (bootstrap, no other checker)',
  REJECT: 'Rejected',
  WITHDRAW: 'Withdrew',
  REASSIGN: 'Reassigned',
  BLOCK: 'Blocked',
  VOID: 'Voided',
  ACTIVATE: 'Activated',
};

export const actorName = (actor: ActorContext): string => actor.principal?.displayName ?? actor.system?.name ?? 'OCSO';

/** The submitted change as a field diff (what the checker reads). */
export const proposalDiff = (p: Pick<ProposalRow, 'beforeSnapshot' | 'afterSnapshot'>): DiffField[] => diffFields(p.beforeSnapshot, p.afterSnapshot);

export interface DecisionRecord {
  reason?: string | null | undefined;
  /** What the actor saw; defaults to the proposal's stored content hash. */
  contentHash?: string | undefined;
  diff?: readonly DiffField[] | undefined;
  warnings?: readonly ApprovalWarning[] | undefined;
  bulkBatchId?: string | null | undefined;
  /** Extra facts for the audit row's `after`. */
  audit?: Record<string, unknown> | undefined;
}

/**
 * One append-only decision row plus its audit event, in the caller's
 * transaction: a decision never exists without its audit trail.
 */
export async function recordDecision(tx: DbOrTx, actor: ActorContext, p: ProposalRow, kind: ApprovalDecisionKind, r: DecisionRecord = {}): Promise<void> {
  const auditEventId = await recordAudit(tx, actor, {
    action: AUDIT_ACTION[kind],
    targetType: 'approval',
    targetId: p.id,
    summary: `${VERB[kind]}: ${p.title}${r.reason ? ` — ${r.reason}` : ''}`,
    after: { objectKind: p.objectKind, objectId: p.objectId, action: p.action, revision: p.revision, checkerId: p.checkerId, ...(r.audit ?? {}) },
  });
  await tx.insert(approvalDecisions).values({
    id: uuidv7(),
    proposalId: p.id,
    revision: p.revision,
    kind,
    actorId: actor.principal?.userId ?? null,
    actorName: actorName(actor),
    reason: r.reason ?? null,
    contentHash: r.contentHash ?? p.contentHash,
    diff: [...(r.diff ?? [])],
    warnings: [...(r.warnings ?? [])],
    bulkBatchId: r.bulkBatchId ?? null,
    auditEventId,
  });
}

/** Realtime: the checker (and reassign_any holders) learn of a new or reassigned proposal. */
export function emitRequested(tx: DbOrTx, actor: ActorContext, p: ProposalRow): Promise<unknown> {
  return emitEvent(tx, actor, 'approval.requested', {
    proposalId: p.id,
    objectKind: p.objectKind,
    objectId: p.objectId,
    action: p.action,
    makerId: p.makerId ?? '',
    checkerId: p.checkerId ?? '',
  });
}

export function emitDecided(tx: DbOrTx, actor: ActorContext, p: ProposalRow, decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'BLOCKED' | 'VOID'): Promise<unknown> {
  return emitEvent(tx, actor, 'approval.decided', {
    proposalId: p.id,
    objectKind: p.objectKind,
    objectId: p.objectId,
    decision,
    checkerId: p.checkerId,
    makerId: p.makerId,
  });
}
