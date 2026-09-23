import { and, inArray, notInArray, sql } from 'drizzle-orm';
import { Permission, type Permission as PermissionName } from '@ocso/auth';
import { auditEvents, userPermissionGrants, users, type DbOrTx } from '@ocso/db';
import type { ApprovalProblem, ProposalRow } from '../../approvals/contract.js';
import { TEAM_IDS_ARRAY, holdsPermissionSql } from '../permissions/state.js';
import { maybeRights } from './rights-projection.js';

/**
 * Who may check a change to someone's rights (PM/research/11 §3.4): a holder of
 * approvals.check.permissions (the spine checks that, ACTIVE and not the
 * maker) who shares a team with the target — or holds users.manage — and is
 * never the target. When nobody but the maker and the target qualifies, any
 * other ACTIVE holder of the check permission may (the platform-wide fallback,
 * ADR-030 deviation 11), so a bootstrap self-approval happens only when nobody
 * anywhere can check — and never because the maker just disabled, demoted or
 * revoked the others (identityBootstrapProblem).
 */

type Checker = { userId: string; teamIds: readonly string[]; permissions: ReadonlySet<PermissionName> };
type Facts = Pick<ProposalRow, 'objectId' | 'makerId'> & Partial<Pick<ProposalRow, 'payload'>>;

/** How long a checker who was disabled (or lost the check permission) still counts as "someone who could check" for bootstrap purposes. */
export const DISABLED_CHECKER_WINDOW_DAYS = 30;

/** Teams the change concerns: the target's teams now, plus those a change set adds them to. */
async function concernedTeams(tx: DbOrTx, p: Facts): Promise<string[]> {
  const rights = await maybeRights(tx, p.objectId);
  const added = (p.payload?.['teams'] as { add?: unknown } | undefined)?.add;
  return [...new Set([...(rights?.teamIds ?? []), ...(Array.isArray(added) ? added.filter((t): t is string => typeof t === 'string') : [])])];
}

function primary(checker: Pick<Checker, 'teamIds'> & { manage: boolean }, teamIds: readonly string[]): boolean {
  return checker.manage || teamIds.some((t) => checker.teamIds.includes(t));
}

/** Holders of approvals.check.permissions in these statuses, in one query (preset ∪ active grants − active revokes). */
async function checkHolders(tx: DbOrTx, statuses: ReadonlyArray<'ACTIVE' | 'DISABLED'>): Promise<Array<{ id: string; teamIds: string[]; manage: boolean }>> {
  return tx
    .select({ id: users.id, teamIds: TEAM_IDS_ARRAY, manage: holdsPermissionSql(Permission.USERS_MANAGE) })
    .from(users)
    .where(and(inArray(users.status, [...statuses]), holdsPermissionSql(Permission.APPROVALS_CHECK_PERMISSIONS)));
}

/** Whether anyone other than the maker and the target is a primary checker. */
async function anyPrimary(tx: DbOrTx, p: Facts, teamIds: readonly string[]): Promise<boolean> {
  const holders = await checkHolders(tx, ['ACTIVE']);
  return holders.some((h) => h.id !== p.makerId && h.id !== p.objectId && primary(h, teamIds));
}

export async function identityCheckerEligible(tx: DbOrTx, checker: Checker, p: Facts): Promise<boolean> {
  if (checker.userId === p.objectId) return false;
  const teamIds = await concernedTeams(tx, p);
  if (primary({ teamIds: checker.teamIds, manage: checker.permissions.has(Permission.USERS_MANAGE) }, teamIds)) return true;
  return !(await anyPrimary(tx, p, teamIds));
}

/**
 * Users (other than `exclude`) who lost `permission` in the last DISABLED_CHECKER_WINDOW_DAYS and are not an ACTIVE
 * holder of it again. Every immediate decrease counts, since each is a stop anyone with users.manage may make at once:
 * - disabled (a `user.disable` audit row) while their preset and grants still give them the permission;
 * - a reduction that dropped it (a `user.permissions_reduced` audit row whose `lost` names it): a preset downgrade
 *   such as HEAD→LEAD, a REVOKE, or clearing a grant;
 * - a GRANT of it that expired (expiry is computed on read, so the grant history is the record).
 * The audit rows are reliable for the window: the local audit window is at least 90 days (deployment_settings).
 */
export async function recentCheckerLosses(tx: DbOrTx, permission: PermissionName, exclude: readonly string[]): Promise<string[]> {
  const since = sql`now() - make_interval(days => ${DISABLED_CHECKER_WINDOW_DAYS})`;
  const holds = holdsPermissionSql(permission);
  const audited = sql`EXISTS (SELECT 1 FROM ${auditEvents} a WHERE a.target_type = 'user' AND a.target_id = "users"."id"::text AND a.occurred_at > ${since}
    AND ((a.action = 'user.disable' AND ${holds}) OR (a.action = 'user.permissions_reduced' AND coalesce(a.after -> 'lost', '[]'::jsonb) @> jsonb_build_array(${permission}::text))))`;
  const expired = sql`EXISTS (SELECT 1 FROM ${userPermissionGrants} x WHERE x.user_id = "users"."id" AND x.permission = ${permission} AND x.effect = 'GRANT'
    AND x.expires_at > ${since} AND x.expires_at <= now() AND (x.cleared_at IS NULL OR x.cleared_at >= x.expires_at))`;
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(exclude.length ? notInArray(users.id, [...exclude]) : undefined, sql`NOT (${users.status} = 'ACTIVE' AND ${holds})`, sql`(${audited} OR ${expired})`));
  return rows.map((r) => r.id);
}

/**
 * A bootstrap self-approval of an identity change is refused while another user recently lost
 * approvals.check.permissions (disabled, demoted, revoked, or a grant expired; recentCheckerLosses): each is a stop
 * anyone with users.manage may do at once, and it must not manufacture the "nobody else can check" that lets the maker
 * approve their own access changes (or a new checker of their choosing). The exceptions bring a checker back:
 * re-enabling a disabled holder of the check permission, or restoring the right to the person who lost it (the
 * target is never counted). A first run, where no other checker ever existed, has no such record.
 */
export async function identityBootstrapProblem(tx: DbOrTx, p: Pick<ProposalRow, 'bootstrap' | 'objectKind' | 'objectId' | 'makerId' | 'action'>): Promise<ApprovalProblem | null> {
  if (!p.bootstrap) return null;
  if (p.objectKind === 'user' && p.action === 'ACTIVATE') {
    const disabled = (await checkHolders(tx, ['DISABLED'])).map((h) => h.id);
    if (disabled.includes(p.objectId)) return null;
  }
  const lost = await recentCheckerLosses(tx, Permission.APPROVALS_CHECK_PERMISSIONS, [p.makerId, p.objectId].filter((id): id is string => Boolean(id)));
  if (!lost.length) return null;
  return {
    code: 'bootstrap_checker_disabled',
    message: `Another checker of access changes was disabled or lost the right to check in the last ${DISABLED_CHECKER_WINDOW_DAYS} days, so this cannot be self-approved: bring a checker back (re-enabling or restoring them alone may be self-approved) and have them check it.`,
  };
}
