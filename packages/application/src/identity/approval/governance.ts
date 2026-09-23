import { and, eq, inArray } from 'drizzle-orm';
import { approvalProposals, type DbOrTx } from '@ocso/db';
import { voidOpen } from '../../approvals/decisions.js';
import { approvalOpenError, lockingProposal } from '../../approvals/guard.js';
import type { ApprovalService } from '../../approvals/proposals.js';
import type { ActorContext } from '../../shared/context.js';
import type { IdentityApprovals, IdentityGovernance, IdentityProposalRef } from '../permissions/gate.js';
import { loadUserRights } from '../permissions/state.js';
import { PERMISSION_CHANGE_KIND, USER_KIND } from './user-approval.js';

/**
 * Wiring of per-user permissions (PERMS, ADR-029) to the approval spine
 * (PM/research/11 §3.4, §4.2): the `IDENTITY_APPROVALS` port and the
 * `onDirectRightsChange` hook.
 */

/**
 * The spine's submit behind PERMS' port. Checker eligibility (never the maker,
 * never the target, a teammate of the target or users.manage, else the
 * platform-wide fallback) and the bootstrap preconditions (the maker holds
 * approvals.check.permissions and nobody else anywhere is eligible) are the
 * descriptors' and the spine's (identity/approval/*, approvals/access.ts).
 */
export function createIdentityApprovals(approvals: ApprovalService): IdentityApprovals {
  return {
    async submit(actor, request): Promise<IdentityProposalRef> {
      const reason = request.approval.reason ?? request.reason;
      const who = 'bootstrap' in request.approval ? { bootstrap: true as const } : { checkerId: request.approval.checkerId };
      const detail = await approvals.submit(actor, { objectKind: request.objectKind, objectId: request.objectId, action: request.action, payload: request.payload, reason, ...who });
      return {
        id: detail.id,
        objectKind: request.objectKind,
        objectId: request.objectId,
        action: request.action,
        status: detail.status,
        checkerId: detail.checker?.id ?? null,
        bootstrap: detail.bootstrap,
      };
    },
  };
}

const related = async (_tx: DbOrTx, userId: string) => [{ kind: PERMISSION_CHANGE_KIND, objectIds: [userId] }];

/**
 * Called under the user's row lock before every direct change to their rights
 * (PERMS). A pending user is a draft whose creation proposal binds its rights:
 * editing it while that proposal is open is refused (409 approval_open — edit
 * or withdraw the proposal first). Discarding a pending user voids its open
 * proposals. Reductions of an approved user always go through (stopping is never
 * gated); a proposal they make stale fails its content hash when decided.
 */
export async function onDirectRightsChange(tx: DbOrTx, actor: ActorContext, event: { userId: string; kind: 'rights' | 'discard' }): Promise<void> {
  const locking = await lockingProposal(tx, { kind: USER_KIND, related }, event.userId);
  if (!locking) return;
  if (event.kind === 'discard') {
    const open = await tx
      .select()
      .from(approvalProposals)
      .where(and(inArray(approvalProposals.objectKind, [USER_KIND, PERMISSION_CHANGE_KIND]), eq(approvalProposals.objectId, event.userId), eq(approvalProposals.status, 'SUBMITTED')))
      .for('update');
    for (const p of open) await voidOpen(tx, actor, p, 'The pending user was discarded', new Date(), actor.principal?.userId ?? null);
    return;
  }
  const rights = await loadUserRights(tx, event.userId);
  if (rights.status === 'PENDING_APPROVAL') throw approvalOpenError(locking.kind, event.userId, locking.id);
}

/** PERMS' governance with the spine plugged in (the API's IDENTITY_GOVERNANCE adds its dev-skip flag to this). */
export function identityGovernanceWith(approvals: ApprovalService | null, base: IdentityGovernance = {}): IdentityGovernance {
  return { ...base, approvals: approvals ? createIdentityApprovals(approvals) : null, onDirectRightsChange };
}
