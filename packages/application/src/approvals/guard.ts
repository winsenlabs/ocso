import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { approvalProposals, users, type DbOrTx } from '@ocso/db';
import { DomainError, ErrorCategory, type ApprovalAction } from '@ocso/domain';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';

/**
 * What every approvable write path calls (PM/research/11b "guard"). An object
 * never approved is a draft: freely editable, inert. Once approved, every
 * change is a proposal; ACTIVATE and DELETE always are. While a proposal is
 * open the object is locked (409 approval_open) — stop actions (pause,
 * disable, revoke) never call the guard.
 */

export interface ProposalRef {
  id: string;
  action: ApprovalAction;
  status: ProposalRow['status'];
  checkerId: string | null;
  checkerName: string | null;
  makerId: string | null;
  submittedAt: Date;
  activating: boolean;
}

export async function isApproved(tx: DbOrTx, kind: string, objectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: approvalProposals.id })
    .from(approvalProposals)
    .where(and(eq(approvalProposals.objectKind, kind), eq(approvalProposals.objectId, objectId), eq(approvalProposals.status, 'APPROVED')))
    .limit(1);
  return Boolean(row);
}

/** The open proposal (at most one, by the partial unique index) per object id. */
export async function openProposals(tx: DbOrTx, kind: string, ids: readonly string[]): Promise<Map<string, ProposalRef>> {
  const out = new Map<string, ProposalRef>();
  if (!ids.length) return out;
  const rows = await tx
    .select({
      id: approvalProposals.id,
      objectId: approvalProposals.objectId,
      action: approvalProposals.action,
      status: approvalProposals.status,
      checkerId: approvalProposals.checkerId,
      checkerName: users.name,
      makerId: approvalProposals.makerId,
      submittedAt: approvalProposals.submittedAt,
    })
    .from(approvalProposals)
    .leftJoin(users, eq(users.id, approvalProposals.checkerId))
    .where(and(eq(approvalProposals.objectKind, kind), inArray(approvalProposals.objectId, [...ids]), eq(approvalProposals.status, 'SUBMITTED')));
  for (const { objectId, ...ref } of rows) out.set(objectId, { ...ref, activating: false });
  return out;
}

/** Approved but not yet activated (deferred path): shown as "Approved — activating". */
async function activating(tx: DbOrTx, kind: string, objectId: string): Promise<ProposalRef | null> {
  const [row] = await tx
    .select({
      id: approvalProposals.id,
      action: approvalProposals.action,
      status: approvalProposals.status,
      checkerId: approvalProposals.checkerId,
      checkerName: users.name,
      makerId: approvalProposals.makerId,
      submittedAt: approvalProposals.submittedAt,
    })
    .from(approvalProposals)
    .leftJoin(users, eq(users.id, approvalProposals.checkerId))
    .where(and(eq(approvalProposals.objectKind, kind), eq(approvalProposals.objectId, objectId), eq(approvalProposals.status, 'APPROVED'), sql`${approvalProposals.activatedAt} IS NULL`))
    .orderBy(desc(approvalProposals.submittedAt))
    .limit(1);
  return row ? { ...row, activating: true } : null;
}

export interface ApprovalState {
  /** At least one approved proposal: the object is live configuration and every change is a proposal. */
  approved: boolean;
  /** The open proposal, or an approved one still activating. */
  pending: ProposalRef | null;
}

export async function approvalState(tx: DbOrTx, kind: string, objectId: string): Promise<ApprovalState> {
  const [approved, open] = await Promise.all([isApproved(tx, kind, objectId), openProposals(tx, kind, [objectId])]);
  return { approved, pending: open.get(objectId) ?? (await activating(tx, kind, objectId)) };
}

/** The default rule: approved objects change only through proposals; ACTIVATE and DELETE always do. */
export async function requiresApproval(tx: DbOrTx, d: ApprovalDescriptor, objectId: string, action: ApprovalAction): Promise<boolean> {
  if (d.requiresApproval) return d.requiresApproval(tx, objectId, action);
  if (action === 'ACTIVATE' || action === 'DELETE') return true;
  return isApproved(tx, d.kind, objectId);
}

export const approvalOpenError = (kind: string, objectId: string, proposalId: string): DomainError =>
  new DomainError(ErrorCategory.CONFLICT, 'approval_open', 'A change to this object is waiting for approval. Edit or withdraw that proposal first.', {
    objectKind: kind,
    objectId,
    proposalId,
  });

export const approvalRequiredError = (kind: string, objectId: string, action: ApprovalAction): DomainError =>
  new DomainError(ErrorCategory.CONFLICT, 'approval_required', 'This change needs approval: name a checker and give a reason.', {
    objectKind: kind,
    objectId,
    action,
  });

/**
 * The proposal that locks this object: its own open one, one open on a related
 * object (an agent and its prompt versions lock each other), or an approved one
 * still activating (deferred) — any of them. Null when the object is free.
 */
export async function lockingProposal(tx: DbOrTx, d: Pick<ApprovalDescriptor, 'kind' | 'related'>, objectId: string): Promise<{ kind: string; objectId: string; id: string } | null> {
  const targets: Array<{ kind: string; objectIds: readonly string[] }> = [{ kind: d.kind, objectIds: [objectId] }, ...((await d.related?.(tx, objectId)) ?? [])];
  for (const t of targets) {
    if (!t.objectIds.length) continue;
    const [row] = await tx
      .select({ id: approvalProposals.id, objectId: approvalProposals.objectId })
      .from(approvalProposals)
      .where(
        and(
          eq(approvalProposals.objectKind, t.kind),
          inArray(approvalProposals.objectId, [...t.objectIds]),
          or(
            eq(approvalProposals.status, 'SUBMITTED'),
            and(eq(approvalProposals.status, 'APPROVED'), eq(approvalProposals.origin, 'USER'), isNull(approvalProposals.activatedAt)),
          ),
        ),
      )
      .limit(1);
    if (row) return { kind: t.kind, objectId: row.objectId, id: row.id };
  }
  return null;
}

/** Serialize every writer of this object's configuration (the descriptor's lock, else `<kind>:<id>`). */
export async function lockFor(tx: DbOrTx, d: ApprovalDescriptor, objectId: string): Promise<void> {
  if (d.lock) await d.lock(tx, objectId);
  else await lockObject(tx, `${d.kind}:${objectId}`);
}

/** Transaction-scoped advisory lock on `ocso:approval:<key>`. */
export async function lockObject(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ocso:approval:${key}`}))`);
}

/** Write scope for proposing: the descriptor's assertMakeable, else its read scope. */
export async function assertMakeable(tx: DbOrTx, d: ApprovalDescriptor, principal: Principal, objectId: string, action: ApprovalAction): Promise<void> {
  if (d.assertMakeable) await d.assertMakeable(tx, principal, objectId, action);
  else await d.assertVisible(tx, principal, objectId);
}

/**
 * Throws 409 approval_open when a proposal locks the object, and 409
 * approval_required when this write must be a proposal. Call inside the
 * write's transaction, after locking the object's row.
 */
export async function assertChangeAllowed(tx: DbOrTx, d: ApprovalDescriptor, objectId: string, action: ApprovalAction = 'UPDATE'): Promise<void> {
  await assertUnlocked(tx, d, objectId);
  if (await requiresApproval(tx, d, objectId, action)) throw approvalRequiredError(d.kind, objectId, action);
}

/** 409 approval_open while a proposal locks the object (for writes that are never proposals themselves). */
export async function assertUnlocked(tx: DbOrTx, d: Pick<ApprovalDescriptor, 'kind' | 'related'>, objectId: string): Promise<void> {
  const open = await lockingProposal(tx, d, objectId);
  if (open) throw approvalOpenError(open.kind, open.objectId, open.id);
}
