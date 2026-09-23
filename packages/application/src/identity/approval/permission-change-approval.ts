import { and, eq, isNull, notExists, or, sql, gt } from 'drizzle-orm';
import { Permission, applyRightsChange, can, classifyRightsChange } from '@ocso/auth';
import { describeDiff, diffFields } from '@ocso/domain';
import { approvalProposals, userPermissionGrants } from '@ocso/db';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../../approvals/contract.js';
import { applyPermissionChangeSet, assertGrantsAllowed, revalidateMaker } from '../permissions/apply.js';
import { PermissionChangeSet, toRightsChange } from '../permissions/change-set.js';
import type { UserRights } from '../permissions/state.js';
import { identityBootstrapProblem, identityCheckerEligible } from './eligibility.js';
import { assertRightsMakeable, assertRightsVisible, lockUserRights, maybeRights, missingTeams, problemOf, projectRights, rightsBasis } from './rights-projection.js';
import { PERMISSION_CHANGE_KIND, USER_KIND } from './user-approval.js';

/**
 * `permission_change` (PM/research/11 §3.4), checked with
 * approvals.check.permissions: the widening part of a change to an approved
 * user's rights — a preset upgrade, a team joined, a grant. The payload is the
 * change set itself (PermissionChangeSet); approval applies it to the user's
 * state at that moment under the row lock, re-validating the maker. Reductions
 * never come here: they apply at once.
 */

function afterOf(rights: UserRights, p: Pick<ProposalRow, 'payload'>) {
  const set = PermissionChangeSet.parse(p.payload);
  return applyRightsChange(rights, toRightsChange(set));
}

export const permissionChangeApproval: ApprovalDescriptor = {
  kind: PERMISSION_CHANGE_KIND,
  label: 'Permission change',
  actions: ['UPDATE'],
  makePermission: () => Permission.PERMISSIONS_MANAGE,
  /** Grants need permissions.manage; presets and memberships users.manage / users.manage_team / teams.manage — validate re-runs the exact rule. */
  mayMake: (principal) =>
    can(principal, Permission.PERMISSIONS_MANAGE) || can(principal, Permission.USERS_MANAGE) || can(principal, Permission.USERS_MANAGE_TEAM) || can(principal, Permission.TEAMS_MANAGE),
  checkPermission: Permission.APPROVALS_CHECK_PERMISSIONS,
  payload: PermissionChangeSet,

  async project(tx, userId) {
    const rights = await maybeRights(tx, userId);
    return rights ? projectRights(tx, rights, rights) : null;
  },
  async projectAfter(tx, p) {
    const rights = await maybeRights(tx, p.objectId);
    if (!rights) return null;
    const after = afterOf(rights, p);
    const gained = classifyRightsChange(rights, after).gained;
    return { ...(await projectRights(tx, rights, after)), newAccess: [...gained].sort() };
  },
  hashBasis: rightsBasis,
  lock: lockUserRights,
  related: async (_tx, userId) => [{ kind: USER_KIND, objectIds: [userId] }],
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
    const parsed = PermissionChangeSet.safeParse(p.payload);
    if (!parsed.success || parsed.data.userId !== p.objectId || (parsed.data.makerId !== undefined && parsed.data.makerId !== p.makerId)) {
      return [{ code: 'invalid_payload', message: 'The proposal does not describe a change to this user.' }];
    }
    const set = parsed.data;
    const problems: ApprovalProblem[] = [];
    const bootstrap = await identityBootstrapProblem(tx, p);
    if (bootstrap) problems.push(bootstrap);
    if (rights.status === 'PENDING_APPROVAL') problems.push({ code: 'user_pending_approval', message: `${rights.email} is not approved yet: change the draft and submit its creation instead.` });
    const now = new Date();
    for (const op of set.ops) {
      if (op.op === 'GRANT' && op.expiresAt && new Date(op.expiresAt).getTime() <= now.getTime()) problems.push({ code: 'grant_expiry_past', message: `The grant of ${op.permission} must expire in the future.` });
    }
    const missing = await missingTeams(tx, set.teams?.add ?? []);
    if (missing.length) problems.push({ code: 'unknown_team', message: 'One or more teams do not exist.' });
    const after = afterOf(rights, p);
    const classification = classifyRightsChange(rights, after, now);
    if (classification.direction !== 'INCREASE') problems.push({ code: 'not_an_increase', message: 'This change does not widen access any more: apply it directly.' });
    try {
      assertGrantsAllowed(after);
      if (p.makerId) {
        const teamsTouched = [...classification.teamsAdded, ...classification.teamsRemoved];
        await revalidateMaker(tx, p.makerId, { targetId: p.objectId, before: rights, after, ops: set.ops.length > 0, presetOrTeams: after.role !== rights.role || teamsTouched.length > 0, teamsTouched });
      }
    } catch (err) {
      problems.push(problemOf(err));
    }
    return problems;
  },
  async activate(tx, actor, p) {
    const set = PermissionChangeSet.parse(p.payload);
    await applyPermissionChangeSet(tx, actor, { ...set, makerId: set.makerId ?? p.makerId ?? undefined }, { proposalId: p.id });
    return { kind: 'DONE' };
  },
  /** People holding a grant that no approved proposal made effective (the exception report's permission bypass). */
  async liveObjects(tx) {
    const rows = await tx
      .selectDistinct({ id: userPermissionGrants.userId })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.effect, 'GRANT'),
          isNull(userPermissionGrants.clearedAt),
          or(isNull(userPermissionGrants.expiresAt), gt(userPermissionGrants.expiresAt, sql`now()`)),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(approvalProposals)
              .where(and(eq(approvalProposals.id, userPermissionGrants.proposalId), eq(approvalProposals.status, 'APPROVED'))),
          ),
        ),
      );
    return rows.map((r) => r.id);
  },
  title(p, before) {
    const who = String(before?.['user'] ?? 'user').split(' <')[0];
    return `Change ${who}'s access: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};
