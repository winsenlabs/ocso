import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Permission, Role, applyRightsChange, classifyRightsChange, forbiddenGrants, type Principal, type RightsClassification, type RightsState } from '@ocso/auth';
import { DomainError, ErrorCategory, conflict, validation } from '@ocso/domain';
import { authAccounts, teamMembers, teams, userPermissionGrants, users, uuidv7, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../../audit/audit.js';
import type { ActorContext } from '../../shared/context.js';
import { CREDENTIAL_PROVIDER, revokeUserSessions } from '../credentials.js';
import { loadPrincipal } from '../sessions.js';
import { PermissionChangeSet, sameUserRights, toRightsChange, userRightsSnapshot, type PermissionChangeSet as ChangeSet, type UserRightsSnapshot } from './change-set.js';
import type { ApprovalSkipReason } from './gate.js';
import { assertMayChangeRights, type RightsChangeScope } from './makers.js';
import { loadUserRights, type UserRights } from './state.js';

export interface AppliedRightsChange {
  classification: RightsClassification;
  before: RightsState;
  after: RightsState;
  /** Sessions ended because the preset changed. */
  sessionsEnded: number;
}

/** Audit snapshot of someone's rights (never secrets; overrides without row ids). */
export function rightsSnapshot(state: RightsState) {
  return {
    role: state.role,
    status: state.status,
    teamIds: [...state.teamIds],
    overrides: state.overrides.map((o) => ({ permission: o.permission, effect: o.effect, expiresAt: o.expiresAt?.toISOString() ?? null })),
  };
}

/**
 * Break-glass guarantee: at least one other active Tech keeps password sign-in
 * and users.manage, so SSO or IdP trouble can never lock the deployment out.
 * Serialized so two admins cannot race past it.
 */
export async function assertBreakGlassRemains(tx: DbOrTx, excludingUserId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ocso:tech-admins'))`);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(authAccounts, and(eq(authAccounts.userId, users.id), eq(authAccounts.providerId, CREDENTIAL_PROVIDER), sql`${authAccounts.password} IS NOT NULL`))
    .where(
      and(
        eq(users.role, Role.TECH),
        eq(users.status, 'ACTIVE'),
        sql`${users.id} <> ${excludingUserId}`,
        sql`NOT EXISTS (SELECT 1 FROM ${userPermissionGrants} g WHERE g.user_id = ${users.id} AND g.permission = ${Permission.USERS_MANAGE} AND g.effect = 'REVOKE' AND g.cleared_at IS NULL)`,
      ),
    );
  if ((row?.n ?? 0) === 0) {
    throw conflict('last_password_admin', 'At least one active Tech admin must keep password sign-in. Add or enable another one first.');
  }
}

/** A Tech losing the preset, being disabled or losing users.manage must leave another break-glass admin. */
export function losesBreakGlass(before: RightsState, after: RightsState): boolean {
  if (before.role !== Role.TECH || before.status !== 'ACTIVE') return false;
  const revokesManage = after.overrides.some((o) => o.permission === Permission.USERS_MANAGE && o.effect === 'REVOKE');
  return after.role !== Role.TECH || after.status !== 'ACTIVE' || revokesManage;
}

async function assertTeamsExist(tx: DbOrTx, teamIds: readonly string[]): Promise<void> {
  if (!teamIds.length) return;
  const found = await tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, [...teamIds]));
  if (found.length !== new Set(teamIds).size) throw validation('unknown_team', 'One or more teams do not exist');
}

/** Tech never holds conversation content, prompts.edit or business analytics — not even through an approved grant. */
export function assertGrantsAllowed(after: Pick<RightsState, 'role' | 'overrides'>): void {
  const blocked = forbiddenGrants(after);
  if (blocked.length) {
    throw validation('grant_not_allowed_for_preset', `The ${after.role} preset can never hold ${blocked.join(', ')}, even through a grant`, { permissions: blocked });
  }
}

/**
 * Maker rules re-run when an approved change activates (§4.1 "re-validate at
 * activation"): the maker must still be active and still allowed to make it.
 */
export async function revalidateMaker(tx: DbOrTx, makerId: string, scope: RightsChangeScope): Promise<void> {
  const maker = await loadPrincipal(tx, makerId, 'UI');
  if (!maker) throw conflict('maker_not_active', 'The person who proposed this change is no longer active: propose it again');
  try {
    assertMayChangeRights(maker, scope);
  } catch (err) {
    if (err instanceof DomainError && err.category === ErrorCategory.AUTHORIZATION) {
      throw conflict('maker_no_longer_eligible', `The person who proposed this change may no longer make it (${err.message}): propose it again`);
    }
    throw err;
  }
}

function auditAction(before: UserRights, classification: RightsClassification): string {
  // A never-approved user is a draft; once approved (even while disabled) changes are increases or reductions.
  if (before.status === 'PENDING_APPROVAL') return 'user.update';
  return classification.direction === 'INCREASE' ? 'user.permissions_increased' : 'user.permissions_reduced';
}

export interface ApplyRightsOptions {
  /** The approval that authorizes it (an increase). */
  proposalId?: string | null | undefined;
  now?: Date | undefined;
  /** Direct writes: the maker, whose rules are re-checked against the state read under the row lock. */
  maker?: Principal | undefined;
  /** Set when a development deployment or the demo seed skipped approval of an increase. */
  approvalSkipped?: ApprovalSkipReason | null | undefined;
}

/**
 * A direct GRANT that only shortens a live, approved grant (a reduction) is still covered by that grant's approval:
 * it carries the approval on, so the exception report never reads it as a grant nobody approved.
 */
function narrowedApproval(cleared: ReadonlyArray<typeof userPermissionGrants.$inferSelect>, expiresAt: Date | null, now: Date): string | null {
  const prev = cleared.find((g) => g.effect === 'GRANT' && g.proposalId && (!g.expiresAt || g.expiresAt > now));
  if (!prev) return null;
  const within = prev.expiresAt === null || (expiresAt !== null && expiresAt.getTime() <= prev.expiresAt.getTime());
  return within ? prev.proposalId : null;
}

function scopeOf(set: ChangeSet, before: RightsState, after: RightsState, classification: RightsClassification): RightsChangeScope {
  const teamsTouched = [...classification.teamsAdded, ...classification.teamsRemoved];
  return { targetId: set.userId, before, after, ops: set.ops.length > 0, presetOrTeams: after.role !== before.role || teamsTouched.length > 0, teamsTouched };
}

/**
 * Apply a rights change set (preset, memberships, grants/revokes/clears) in
 * the caller's transaction, with its audit row. The caller has already decided
 * it may apply: a decrease, an approved proposal (`proposalId`), or a
 * development deployment. This is what the `permission_change` descriptor's
 * activate() calls in wave 2. Everything is decided against the state read
 * under the user's row lock: the maker rules (for a direct write, `maker`; for
 * an approval, the stored `makerId` re-validated now), the structural rules
 * (teams exist, grants expire in the future, the last break-glass Tech admin
 * stays) and the grants a preset may never hold.
 */
export async function applyPermissionChangeSet(tx: DbOrTx, actor: ActorContext, raw: ChangeSet, options: ApplyRightsOptions = {}): Promise<AppliedRightsChange> {
  const set = PermissionChangeSet.parse(raw);
  const now = options.now ?? new Date();
  const before = await loadUserRights(tx, set.userId, { lock: true });
  const ops = toRightsChange(set).ops ?? [];
  for (const op of ops) {
    if (op.op === 'GRANT' && op.expiresAt && op.expiresAt.getTime() <= now.getTime()) throw validation('grant_expiry_past', `The grant of ${op.permission} must expire in the future`);
  }
  await assertTeamsExist(tx, set.teams?.add ?? []);
  const after = applyRightsChange(before, toRightsChange(set));
  const classification = classifyRightsChange(before, after, now);
  assertGrantsAllowed(after);
  const scope = scopeOf(set, before, after, classification);
  if (options.maker) assertMayChangeRights(options.maker, scope);
  if (options.proposalId && set.makerId) await revalidateMaker(tx, set.makerId, scope);
  if (losesBreakGlass(before, after)) await assertBreakGlassRemains(tx, set.userId);

  const actorId = actor.principal?.userId ?? null;
  const createdBy = set.makerId ?? actorId;
  if (after.role !== before.role) await tx.update(users).set({ role: after.role, updatedAt: now }).where(eq(users.id, set.userId));
  if (classification.teamsRemoved.length) {
    await tx.delete(teamMembers).where(and(eq(teamMembers.userId, set.userId), inArray(teamMembers.teamId, classification.teamsRemoved)));
  }
  if (classification.teamsAdded.length) {
    await tx.insert(teamMembers).values(classification.teamsAdded.map((teamId) => ({ teamId, userId: set.userId }))).onConflictDoNothing();
  }
  for (const op of ops) {
    // One live override per permission: whatever it had (even expired) is cleared first.
    const cleared = await tx
      .update(userPermissionGrants)
      .set({ clearedAt: now, clearedBy: actorId })
      .where(and(eq(userPermissionGrants.userId, set.userId), eq(userPermissionGrants.permission, op.permission), isNull(userPermissionGrants.clearedAt)))
      .returning();
    if (op.op === 'CLEAR') continue;
    await tx.insert(userPermissionGrants).values({
      id: uuidv7(),
      userId: set.userId,
      permission: op.permission,
      effect: op.op,
      expiresAt: op.op === 'GRANT' ? op.expiresAt : null,
      reason: set.reason,
      proposalId: options.proposalId ?? (op.op === 'GRANT' ? narrowedApproval(cleared, op.expiresAt ?? null, now) : null),
      createdBy,
      createdAt: now,
    });
  }
  // A preset change ends every session at once. Grants and revokes take effect on the next request, and open
  // streams re-check the user's rights every minute (SessionLiveness) and close when they shrank.
  const sessionsEnded = after.role !== before.role ? await revokeUserSessions(tx, set.userId) : 0;
  if (classification.direction !== 'NONE') {
    const skipped = classification.direction === 'INCREASE' && !options.proposalId ? (options.approvalSkipped ?? null) : null;
    const parts = [
      after.role !== before.role ? `preset ${before.role} → ${after.role}` : null,
      classification.teamsAdded.length ? `joined ${classification.teamsAdded.length} team(s)` : null,
      classification.teamsRemoved.length ? `left ${classification.teamsRemoved.length} team(s)` : null,
      ...ops.map((o) => `${o.op.toLowerCase()} ${o.permission}`),
      sessionsEnded ? `ended ${sessionsEnded} session(s)` : null,
    ].filter(Boolean);
    await recordAudit(tx, actor, {
      action: auditAction(before, classification),
      targetType: 'user',
      targetId: set.userId,
      summary: `Changed access of ${before.email}: ${parts.join(', ')}${options.proposalId ? ' (approved)' : ''}${skipped ? ` (approval skipped: ${skipped})` : ''}`,
      before: rightsSnapshot(before),
      after: {
        ...rightsSnapshot(after),
        reason: set.reason,
        proposalId: options.proposalId ?? null,
        makerId: set.makerId ?? actorId,
        gained: classification.gained,
        lost: classification.lost,
        teamsAdded: classification.teamsAdded,
        teamsRemoved: classification.teamsRemoved,
        ...(skipped ? { approvalSkipped: skipped } : {}),
      },
    });
  }
  return { classification, before, after, sessionsEnded };
}

export interface ActivatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** What the user was: a new user awaiting approval, or a disabled one being re-enabled. */
  from: 'PENDING_APPROVAL' | 'DISABLED';
}

export interface ActivateUserOptions {
  proposalId?: string | null | undefined;
  /** The rights the approval was given for (the `user` proposal's `rights`): any other state is refused. */
  expected?: UserRightsSnapshot | undefined;
  /** Who proposed it: re-validated when an approval activates it. */
  makerId?: string | undefined;
  approvalSkipped?: ApprovalSkipReason | null | undefined;
}

/**
 * Make a pending (or disabled) user ACTIVE, audited, in the caller's
 * transaction. What the `user` descriptor's activate() calls in wave 2 with the
 * proposal's payload (`expected` = payload.rights, `makerId`); the invite email
 * is sent afterwards (deferred) by UserService.sendActivationInvite.
 */
export async function activateUser(tx: DbOrTx, actor: ActorContext, userId: string, options: ActivateUserOptions = {}): Promise<ActivatedUser> {
  const user = await loadUserRights(tx, userId, { lock: true });
  if (user.status === 'ACTIVE') throw conflict('user_already_active', `${user.email} is already active`);
  const from = user.status;
  const current = userRightsSnapshot(user);
  if (options.expected && !sameUserRights(options.expected, current)) {
    throw conflict('user_changed_since_proposal', `${user.email}'s preset, teams or permissions changed after this was proposed: propose it again`);
  }
  assertGrantsAllowed(user);
  const after: RightsState = { ...user, status: 'ACTIVE' };
  if (options.proposalId && options.makerId) {
    const creating = from === 'PENDING_APPROVAL';
    await revalidateMaker(tx, options.makerId, { targetId: userId, before: creating ? null : user, after, ops: false, presetOrTeams: true, teamsTouched: creating ? user.teamIds : [] });
  }
  await tx.update(users).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(users.id, userId));
  const skipped = options.proposalId ? null : (options.approvalSkipped ?? null);
  await recordAudit(tx, actor, {
    action: from === 'PENDING_APPROVAL' ? 'user.activate' : 'user.enable',
    targetType: 'user',
    targetId: userId,
    summary: `${from === 'PENDING_APPROVAL' ? 'Activated new user' : 'Re-enabled'} ${user.email} (${user.role})${options.proposalId ? ' (approved)' : ''}${skipped ? ` (approval skipped: ${skipped})` : ''}`,
    before: { status: from },
    after: { status: 'ACTIVE', proposalId: options.proposalId ?? null, makerId: options.makerId ?? null, rights: current, ...(skipped ? { approvalSkipped: skipped } : {}) },
  });
  return { id: user.userId, email: user.email, name: user.name, role: user.role, from };
}
