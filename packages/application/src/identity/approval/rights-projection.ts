import { and, asc, eq, inArray } from 'drizzle-orm';
import { Permission, ROLE_LABELS, can, isOverrideActive, type Principal, type RightsState } from '@ocso/auth';
import { forbidden, notFound, validation } from '@ocso/domain';
import { teams, users, type DbOrTx } from '@ocso/db';
import { lockObject } from '../../approvals/guard.js';
import { userRightsSnapshot } from '../permissions/change-set.js';
import { loadUserRights, type UserRights } from '../permissions/state.js';

/**
 * What the `user` and `permission_change` descriptors share (PM/research/11
 * §3.4): the checker-readable projection of someone's rights, the hash basis
 * (identifiers only), the lock and the scopes. Both kinds address the target
 * user by id, share one lock and lock each other.
 */

/** Checker-readable: preset, status, team names, and every grant (with its expiry) and revoke — never secrets. */
export async function projectRights(tx: DbOrTx, who: Pick<UserRights, 'name' | 'email'>, state: RightsState, now = new Date()): Promise<Record<string, unknown>> {
  const teamNames = state.teamIds.length
    ? (await tx.select({ name: teams.name }).from(teams).where(inArray(teams.id, [...state.teamIds])).orderBy(asc(teams.name))).map((t) => t.name)
    : [];
  const active = state.overrides.filter((o) => isOverrideActive(o, now));
  const grants = Object.fromEntries(
    active
      .filter((o) => o.effect === 'GRANT')
      .sort((a, b) => a.permission.localeCompare(b.permission))
      .map((o) => [o.permission, o.expiresAt ? `until ${o.expiresAt.toISOString().slice(0, 10)}` : 'no expiry']),
  );
  const revokes = Object.fromEntries(
    active
      .filter((o) => o.effect === 'REVOKE')
      .sort((a, b) => a.permission.localeCompare(b.permission))
      .map((o) => [o.permission, 'revoked']),
  );
  return { user: `${who.name} <${who.email}>`, preset: ROLE_LABELS[state.role], status: state.status, teams: teamNames, grants, revokes };
}

/** The content hash covers the rights themselves (preset, team ids, overrides) — not the status a stop may change. */
export async function rightsBasis(tx: DbOrTx, userId: string): Promise<Record<string, unknown> | null> {
  const rights = await maybeRights(tx, userId);
  return rights ? { userId, ...userRightsSnapshot(rights) } : null;
}

export async function maybeRights(tx: DbOrTx, userId: string): Promise<UserRights | null> {
  const [exists] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return exists ? loadUserRights(tx, userId) : null;
}

/** One lock for everything about one person's rights: the approval key, then the user row (every direct write locks it too). */
export async function lockUserRights(tx: DbOrTx, userId: string): Promise<void> {
  await lockObject(tx, `user:${userId}`);
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

/** Visibility of a proposal about someone's rights: users.manage, the person themselves, or a teammate who reads users or permissions. */
export async function assertRightsVisible(tx: DbOrTx, principal: Principal, userId: string): Promise<void> {
  const rights = await maybeRights(tx, userId);
  if (!rights) throw notFound('user', userId);
  if (can(principal, Permission.USERS_MANAGE) || principal.userId === userId) return;
  const shares = rights.teamIds.some((t) => principal.teamIds.includes(t));
  if (!shares || !(can(principal, Permission.USERS_READ) || can(principal, Permission.PERMISSIONS_READ))) throw notFound('user', userId);
}

/**
 * Coarse write scope for proposing (the precise maker rules — containment, own teams — are re-run on the
 * proposal's own change in `validate`, where the payload is known): never yourself; users.manage anywhere;
 * otherwise a colleague who shares a team with you, or someone joining one of the teams you manage.
 */
export async function assertRightsMakeable(tx: DbOrTx, principal: Principal, userId: string): Promise<void> {
  if (principal.userId === userId) throw forbidden(Permission.PERMISSIONS_MANAGE, 'you cannot change your own access; ask a colleague');
  const rights = await maybeRights(tx, userId);
  if (!rights) throw notFound('user', userId);
  if (can(principal, Permission.USERS_MANAGE)) return;
  if (rights.teamIds.some((t) => principal.teamIds.includes(t))) return;
  if (can(principal, Permission.TEAMS_MANAGE) || can(principal, Permission.USERS_MANAGE_TEAM)) return;
  throw notFound('user', userId);
}

/** Target teams that exist (for validation of a change set's additions). */
export async function missingTeams(tx: DbOrTx, teamIds: readonly string[]): Promise<string[]> {
  if (!teamIds.length) return [];
  const found = await tx.select({ id: teams.id }).from(teams).where(and(inArray(teams.id, [...teamIds])));
  return teamIds.filter((id) => !found.some((f) => f.id === id));
}

export const problemOf = (err: unknown): { code: string; message: string } => {
  const e = err as { code?: unknown; message?: unknown };
  return { code: typeof e.code === 'string' ? e.code : 'invalid', message: typeof e.message === 'string' ? e.message : 'Invalid change' };
};

export const noSelf = (makerId: string | null, userId: string) => {
  if (makerId === userId) throw validation('self_change', 'Nobody proposes changes to their own access');
};
