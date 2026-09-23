import { and, eq, inArray } from 'drizzle-orm';
import { approvalProposals, type DbOrTx } from '@ocso/db';
import { openProposals, type ProposalRef } from './guard.js';

/** Approval state of one object in a list: approved at least once, and the proposal waiting on it (if any). */
export interface ListedApprovalState {
  approved: boolean;
  pending: ProposalRef | null;
}

/**
 * `approvalState` for a whole list of objects of one kind in two queries (a
 * rule list, a template list): which were ever approved, and each one's open
 * proposal. An approved proposal still activating counts as pending.
 */
export async function approvalStates(tx: DbOrTx, kind: string, ids: readonly string[]): Promise<Map<string, ListedApprovalState>> {
  const out = new Map<string, ListedApprovalState>(ids.map((id) => [id, { approved: false, pending: null }]));
  if (!ids.length) return out;
  const [approved, open] = await Promise.all([
    tx
      .select({ objectId: approvalProposals.objectId, activatedAt: approvalProposals.activatedAt, origin: approvalProposals.origin, id: approvalProposals.id, action: approvalProposals.action, checkerId: approvalProposals.checkerId, makerId: approvalProposals.makerId, submittedAt: approvalProposals.submittedAt })
      .from(approvalProposals)
      .where(and(eq(approvalProposals.objectKind, kind), inArray(approvalProposals.objectId, [...ids]), eq(approvalProposals.status, 'APPROVED'))),
    openProposals(tx, kind, ids),
  ]);
  for (const row of approved) {
    const state = out.get(row.objectId)!;
    state.approved = true;
    if (row.activatedAt === null && row.origin === 'USER' && !state.pending) {
      state.pending = { id: row.id, action: row.action, status: 'APPROVED', checkerId: row.checkerId, checkerName: null, makerId: row.makerId, submittedAt: row.submittedAt, activating: true };
    }
  }
  for (const [id, ref] of open) out.get(id)!.pending = ref;
  return out;
}
