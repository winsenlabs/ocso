import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ROLES, ROLE_PERMISSIONS, isPermission, type Permission, type PermissionOverride, type RightsState } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { teamMembers, userPermissionGrants, users, type DbOrTx } from '@ocso/db';

/** An uncleared override row with who set it and why (the effective-permissions screen). */
export interface OverrideRow extends PermissionOverride {
  id: string;
  reason: string;
  proposalId: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface UserRights extends RightsState {
  userId: string;
  email: string;
  name: string;
  overrides: OverrideRow[];
}

/** Uncleared overrides of a user (expired ones included: callers decide with isOverrideActive). */
export async function overrideRows(db: DbOrTx, userId: string): Promise<OverrideRow[]> {
  const rows = await db
    .select({
      id: userPermissionGrants.id,
      permission: userPermissionGrants.permission,
      effect: userPermissionGrants.effect,
      expiresAt: userPermissionGrants.expiresAt,
      reason: userPermissionGrants.reason,
      proposalId: userPermissionGrants.proposalId,
      createdBy: userPermissionGrants.createdBy,
      createdAt: userPermissionGrants.createdAt,
    })
    .from(userPermissionGrants)
    .where(and(eq(userPermissionGrants.userId, userId), isNull(userPermissionGrants.clearedAt)))
    .orderBy(asc(userPermissionGrants.createdAt));
  // A permission removed from the catalogue grants nothing.
  return rows.flatMap((r) => (isPermission(r.permission) ? [{ ...r, permission: r.permission }] : []));
}

/**
 * Everything that decides a user's rights. `lock` takes the row lock that
 * serializes concurrent changes to one user (inside a transaction).
 */
export async function loadUserRights(db: DbOrTx, userId: string, options: { lock?: boolean } = {}): Promise<UserRights> {
  const query = db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [user] = options.lock ? await query.for('update') : await query;
  if (!user) throw notFound('user', userId);
  const [teams, overrides] = await Promise.all([
    db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)),
    overrideRows(db, userId),
  ]);
  return { userId: user.id, email: user.email, name: user.name, role: user.role, status: user.status, teamIds: teams.map((t) => t.teamId), overrides };
}

/**
 * Active overrides of the selected user, as JSON, for a select from `users` (loadPrincipal reads them with
 * the teams in one statement). The outer column is spelled out: drizzle leaves single-table columns unqualified.
 */
export const ACTIVE_OVERRIDES_JSON = sql<Array<{ p: string; e: 'GRANT' | 'REVOKE' }>>`coalesce((
  SELECT json_agg(json_build_object('p', g.permission, 'e', g.effect))
  FROM ${userPermissionGrants} g
  WHERE g.user_id = "users"."id" AND g.cleared_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
), '[]'::json)`;

export const TEAM_IDS_ARRAY = sql<string[]>`coalesce((SELECT array_agg(tm.team_id::text) FROM ${teamMembers} tm WHERE tm.user_id = "users"."id"), '{}'::text[])`;

/**
 * SQL predicate over `users`: the user holds `permission` effectively now —
 * their preset has it and no active REVOKE takes it away, or an active GRANT
 * gives it. For queries that pick people (handoff routing) rather than check a
 * principal already loaded.
 */
export function holdsPermissionSql(permission: Permission) {
  const presets = ROLES.filter((r) => ROLE_PERMISSIONS[r].has(permission));
  const override = (effect: 'GRANT' | 'REVOKE') =>
    sql`EXISTS (SELECT 1 FROM ${userPermissionGrants} g WHERE g.user_id = "users"."id" AND g.permission = ${permission} AND g.effect = ${effect} AND g.cleared_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now()))`;
  const byPreset = presets.length ? sql`("users"."role" IN (${sql.join(presets.map((r) => sql`${r}`), sql`, `)}) AND NOT ${override('REVOKE')})` : sql`false`;
  return sql<boolean>`(${byPreset} OR ${override('GRANT')})`;
}
