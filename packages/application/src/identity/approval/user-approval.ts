import { eq, inArray } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { validation } from '@ocso/domain';
import { users } from '@ocso/db';
import type { ApprovalDescriptor, ApprovalProblem } from '../../approvals/contract.js';
import type { AuthMailer } from '../auth-mailer.js';
import { activateUser, assertGrantsAllowed, revalidateMaker } from '../permissions/apply.js';
import { UserProposalPayload, sameUserRights, userRightsSnapshot } from '../permissions/change-set.js';
import { loadUserRights } from '../permissions/state.js';
import { hasSignInMethod } from '../user-writes.js';
import { UserService } from '../users.js';
import { identityBootstrapProblem, identityCheckerEligible } from './eligibility.js';
import { assertRightsMakeable, assertRightsVisible, lockUserRights, maybeRights, problemOf, projectRights, rightsBasis } from './rights-projection.js';

/**
 * `user` (PM/research/11 §3.4, §4), checked with approvals.check.permissions:
 * CREATE activates a new user (PENDING_APPROVAL → ACTIVE, exactly the rights
 * the checker saw) in the approval's transaction and then — DEFERRED, in the
 * worker — sends their invite. The activation is `settled`: the invite is a
 * follow-up that can fail (recorded) but never blocks an approved, active user;
 * ACTIVATE re-enables a disabled one. The checker is never the maker nor the
 * person whose access it is.
 */
export const USER_KIND = 'user';
export const PERMISSION_CHANGE_KIND = 'permission_change';

export interface UserApprovalDeps {
  /** Sends the invite once a new user's creation is approved; the worker provides it (null: no email here, the admin hands over access). */
  authMailer?: AuthMailer | null | undefined;
}

const mayMakeUsers = (principal: Parameters<typeof can>[0]) => can(principal, Permission.USERS_MANAGE) || can(principal, Permission.USERS_MANAGE_TEAM);

export function userApproval(deps: UserApprovalDeps = {}): ApprovalDescriptor {
  return {
    kind: USER_KIND,
    label: 'User',
    actions: ['CREATE', 'ACTIVATE'],
    makePermission: () => Permission.USERS_MANAGE,
    mayMake: (principal) => mayMakeUsers(principal),
    checkPermission: Permission.APPROVALS_CHECK_PERMISSIONS,
    payload: UserProposalPayload,

    async project(tx, userId) {
      const rights = await maybeRights(tx, userId);
      return rights ? projectRights(tx, rights, rights) : null;
    },
    async projectAfter(tx, p) {
      const rights = await maybeRights(tx, p.objectId);
      if (!rights) return null;
      const after = await projectRights(tx, rights, { ...rights, status: 'ACTIVE' });
      if (p.action !== 'CREATE') return after;
      // The checker must know whether the maker set a password they know, or the person gets an invite.
      return { ...after, onboarding: (await hasSignInMethod(tx, p.objectId)) ? 'password set by the maker' : 'invite email' };
    },
    hashBasis: rightsBasis,
    lock: lockUserRights,
    related: async (_tx, userId) => [{ kind: PERMISSION_CHANGE_KIND, objectIds: [userId] }],
    async teamIds(tx, userId) {
      return [...((await maybeRights(tx, userId))?.teamIds ?? [])].sort();
    },
    dependencies: async () => [],
    assertVisible: assertRightsVisible,
    assertMakeable: assertRightsMakeable,
    eligible: (tx, checker, p) => identityCheckerEligible(tx, checker, p),
    async validate(tx, p) {
      const rights = await maybeRights(tx, p.objectId);
      if (!rights) return [{ code: 'object_missing', message: 'The user no longer exists.' }];
      const problems: ApprovalProblem[] = [];
      const bootstrap = await identityBootstrapProblem(tx, p);
      if (bootstrap) problems.push(bootstrap);
      // Once approved, a deferred retry (the invite) finds the user already active: that is the approved state.
      const expected = p.status === 'APPROVED' ? ['PENDING_APPROVAL', 'ACTIVE'] : [p.action === 'CREATE' ? 'PENDING_APPROVAL' : 'DISABLED'];
      if (!expected.includes(rights.status)) problems.push({ code: 'user_state_changed', message: `${rights.email} is ${rights.status.toLowerCase().replace('_', ' ')}.` });
      if (p.action === 'CREATE') {
        const payload = UserProposalPayload.safeParse(p.payload);
        if (!payload.success || payload.data.userId !== p.objectId || payload.data.makerId !== p.makerId) problems.push({ code: 'invalid_payload', message: 'The proposal does not describe this user.' });
        else if (!sameUserRights(payload.data.rights, userRightsSnapshot(rights))) problems.push({ code: 'user_changed_since_proposal', message: `${rights.email}'s preset, teams or permissions changed after this was proposed.` });
      }
      try {
        assertGrantsAllowed(rights);
        if (p.makerId) {
          const creating = p.action === 'CREATE';
          const after = { ...rights, status: 'ACTIVE' as const };
          await revalidateMaker(tx, p.makerId, { targetId: p.objectId, before: creating ? null : rights, after, ops: false, presetOrTeams: true, teamsTouched: creating ? rights.teamIds : [] });
        }
      } catch (err) {
        problems.push(problemOf(err));
      }
      return problems;
    },
    async activate(tx, actor, p) {
      const rights = await loadUserRights(tx, p.objectId, { lock: true });
      if (p.action === 'CREATE') {
        const payload = UserProposalPayload.parse(p.payload);
        await activateUser(tx, actor, p.objectId, { proposalId: p.id, expected: payload.rights, makerId: p.makerId ?? undefined });
        return { kind: 'DEFERRED' }; // the invite email leaves the transaction
      }
      if (rights.status !== 'DISABLED') throw validation('user_state_changed', `${rights.email} is not disabled`);
      await activateUser(tx, actor, p.objectId, { proposalId: p.id, makerId: p.makerId ?? undefined });
      return { kind: 'DONE' };
    },
    /** The invite, once: skipped when the user already signs in, was invited after the approval, or email is not set up here. */
    async activateDeferred(db, actor, p) {
      const [user] = await db.select({ status: users.status, invitedAt: users.invitedAt }).from(users).where(eq(users.id, p.objectId));
      if (!user || user.status !== 'ACTIVE' || !deps.authMailer) return;
      if (user.invitedAt && p.decidedAt && user.invitedAt >= p.decidedAt) return;
      if (await hasSignInMethod(db, p.objectId)) return;
      await new UserService(db, { mailer: deps.authMailer }).sendActivationInvite(actor, p.objectId);
    },
    /** A new user is active from the approval's transaction on; only their invite is left (never a reason to block). */
    settled: async (_db, p) => p.action === 'CREATE',
    /** Everyone who can sign in: each must carry an approval (grandfathered, installed at setup, or a checker's). */
    async liveObjects(tx) {
      return (await tx.select({ id: users.id }).from(users).where(inArray(users.status, ['ACTIVE']))).map((r) => r.id);
    },
    title(p, before) {
      const who = String(before?.['user'] ?? 'user').split(' <')[0];
      return p.action === 'CREATE' ? `Create ${String(before?.['preset'] ?? '')} ${who}`.replace('  ', ' ') : `Re-enable ${who}`;
    },
  };
}
