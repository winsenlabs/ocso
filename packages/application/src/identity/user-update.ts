import { eq, sql } from 'drizzle-orm';
import { Permission, applyRightsChange, classifyRightsChange, isEmptyRightsChange, planRightsChange, type Principal, type RightsChange, type RightsClassification } from '@ocso/auth';
import { conflict, forbidden, validation } from '@ocso/domain';
import { userPermissionGrants, users, type Db, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { deleteUserVerifications } from './credentials.js';
import { activateUser, applyPermissionChangeSet, losesBreakGlass } from './permissions/apply.js';
import { toChangeSet, userRightsSnapshot, type ApprovalChoice, type UserProposalPayload } from './permissions/change-set.js';
import { proposeIncrease, skipMarker, type IdentityGovernance, type IdentityProposalRef } from './permissions/gate.js';
import { assertMayChangeRights } from './permissions/makers.js';
import { withAppliedPart } from './permissions/service.js';
import { loadUserRights } from './permissions/state.js';
import { UpdateUserInput } from './user-inputs.js';
import { disableUser, profileOf, writeProfile } from './user-writes.js';

export const DEFAULT_REASON = 'Changed on the Team page';

/** Submit a `user` proposal (CREATE a pending user, or ACTIVATE a disabled one) bound to the user's rights now. */
export async function submitUserProposal(
  db: DbOrTx,
  governance: IdentityGovernance,
  actor: ActorContext,
  userId: string,
  action: 'CREATE' | 'ACTIVATE',
  approval: ApprovalChoice | undefined,
  reason: string,
): Promise<IdentityProposalRef> {
  const rights = await loadUserRights(db, userId);
  const payload: UserProposalPayload = { userId, makerId: actor.principal!.userId, rights: userRightsSnapshot(rights) };
  return proposeIncrease(governance, actor, { objectKind: 'user', objectId: userId, action, payload, approval, reason });
}

/** What the locked part of an update decided; the proposal (if any) is submitted after it commits. */
interface UpdateStep {
  submit: 'CREATE' | 'ACTIVATE' | 'PERMISSIONS' | null;
  proposed: RightsChange | null;
  applied: RightsClassification | null;
  activatedPending: boolean;
}

/**
 * PATCH /v1/users/:id (PM/research/11 §3.4). Under the user's row lock: the
 * maker rules, the split of the change into what only takes access away
 * (applied now, even alongside an increase) and what widens it (proposed after
 * commit, or 409 approval_required). A pending user is a draft: preset and
 * teams are edited freely; `status: 'ACTIVE'` or `approval` submits their
 * creation for approval (its proposal binds the rights it approves).
 */
export async function updateUser(db: Db, governance: IdentityGovernance, actor: ActorContext, id: string, raw: UpdateUserInput): Promise<IdentityProposalRef | null | 'activated'> {
  const input = UpdateUserInput.parse(raw);
  const principal = actor.principal;
  if (!principal) throw forbidden(Permission.USERS_MANAGE, 'no principal');
  const skip = Boolean(governance.skipAccessApproval);
  const skipped = skipMarker(governance);
  const reason = input.reason ?? input.approval?.reason ?? DEFAULT_REASON;
  const profile = profileOf(input);

  const step = await db.transaction(async (tx): Promise<UpdateStep> => {
    const before = await loadUserRights(tx, id, { lock: true });
    const pending = before.status === 'PENDING_APPROVAL';
    const teamIds = input.teamIds ? [...new Set(input.teamIds)] : undefined;
    const teamsDelta = teamIds ? { add: teamIds.filter((t) => !before.teamIds.includes(t)), remove: before.teamIds.filter((t) => !teamIds.includes(t)) } : undefined;
    const role = input.role !== undefined && input.role !== before.role ? input.role : undefined;
    const status = input.status !== undefined && input.status !== before.status ? input.status : undefined;
    if (pending && status === 'DISABLED') throw conflict('user_pending_approval', 'A user awaiting approval cannot be disabled: discard them instead');
    // For a pending user, ACTIVE means "submit the creation" (activation is the approval's to do).
    const submitCreate = pending && (status === 'ACTIVE' || input.approval !== undefined);
    const change: RightsChange = { role, status: pending ? undefined : status, teams: teamsDelta };
    const after = applyRightsChange(before, change);
    const whole = classifyRightsChange(before, after);
    const teamsTouched = [...whole.teamsAdded, ...whole.teamsRemoved];
    const touchesRights = role !== undefined || status !== undefined || teamsTouched.length > 0 || submitCreate;
    // Anyone may leave their own teams; everything else about their own access is someone else's call.
    const selfLeaving = principal.userId === id && role === undefined && status === undefined && whole.teamsAdded.length === 0 && !submitCreate;
    if (principal.userId === id && !selfLeaving && touchesRights) throw forbidden('users.manage', 'you cannot change your own access; ask a colleague');
    if (principal.userId !== id) assertMayChangeRights(principal, { targetId: id, before, after, ops: false, presetOrTeams: true, teamsTouched });
    const maker: Principal | undefined = selfLeaving ? undefined : principal;

    const plan = planRightsChange(before, change);
    const direct = skip ? change : plan.direct;
    const proposed = skip ? null : plan.proposed;
    // One proposal carries one kind of change: re-enabling (user ACTIVATE) goes alone.
    if (proposed?.status === 'ACTIVE' && (proposed.role !== undefined || proposed.teams?.add?.length || proposed.ops?.length)) {
      throw validation('activate_alone', 'Re-enable the user on its own, then change their access');
    }
    if (Object.keys(profile).length) await writeProfile(tx, actor, id, before.email, profile);
    if (!isEmptyRightsChange(direct) || (submitCreate && skip)) await governance.onDirectRightsChange?.(tx, actor, { userId: id, kind: 'rights' });
    if (direct.role !== undefined || direct.teams?.add?.length || direct.teams?.remove?.length) {
      await applyPermissionChangeSet(tx, actor, toChangeSet(id, { role: direct.role, teams: direct.teams }, reason), { maker, approvalSkipped: skipped });
    }
    if (direct.status === 'DISABLED') await disableUser(tx, actor, id, before.email, losesBreakGlass(before, after));
    if (direct.status === 'ACTIVE') await activateUser(tx, actor, id, { approvalSkipped: skipped });
    const activatedPending = submitCreate && skip;
    if (activatedPending) await activateUser(tx, actor, id, { approvalSkipped: skipped });
    const submit = submitCreate && !skip ? 'CREATE' : proposed?.status === 'ACTIVE' ? 'ACTIVATE' : proposed ? 'PERMISSIONS' : null;
    return { submit, proposed, applied: isEmptyRightsChange(direct) ? null : plan.directClassification, activatedPending };
  });

  if (step.activatedPending) return 'activated';
  if (!step.submit) return null;
  try {
    if (step.submit === 'CREATE' || step.submit === 'ACTIVATE') return await submitUserProposal(db, governance, actor, id, step.submit, input.approval, reason);
    return await proposeIncrease(governance, actor, {
      objectKind: 'permission_change',
      objectId: id,
      action: 'UPDATE',
      payload: toChangeSet(id, step.proposed!, reason, principal.userId),
      approval: input.approval,
      reason,
    });
  } catch (err) {
    throw withAppliedPart(err, step.applied);
  }
}

/** Delete a never-approved user (and their memberships, credentials and links), audited. */
export async function removePendingUser(tx: DbOrTx, actor: ActorContext, id: string, email: string, summary: string): Promise<void> {
  const [grants] = await tx.select({ n: sql<number>`count(*)::int` }).from(userPermissionGrants).where(eq(userPermissionGrants.userId, id));
  if ((grants?.n ?? 0) > 0) throw conflict('user_has_history', `${email} has permission history and cannot be discarded`);
  await deleteUserVerifications(tx, id);
  await tx.delete(users).where(eq(users.id, id));
  await recordAudit(tx, actor, { action: 'user.discard', targetType: 'user', targetId: id, summary });
}

/** DELETE /v1/users/:id: discard a user whose creation was never approved (frees the email). */
export async function discardPendingUser(db: Db, governance: IdentityGovernance, actor: ActorContext, id: string): Promise<void> {
  const principal = actor.principal;
  if (!principal) throw forbidden(Permission.USERS_MANAGE, 'no principal');
  await db.transaction(async (tx) => {
    const rights = await loadUserRights(tx, id, { lock: true });
    if (rights.status !== 'PENDING_APPROVAL') throw conflict('user_not_pending', 'Only a user whose creation was never approved can be discarded: disable active users instead');
    assertMayChangeRights(principal, { targetId: id, before: rights, after: rights, ops: false, presetOrTeams: true, teamsTouched: [] });
    await governance.onDirectRightsChange?.(tx, actor, { userId: id, kind: 'discard' });
    await removePendingUser(tx, actor, id, rights.email, `Discarded ${rights.email} (${rights.role}), never approved`);
  });
}
