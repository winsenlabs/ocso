import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { Permission, type Permission as PermissionName } from '@ocso/auth';
import { auditEvents, users, type DbOrTx } from '@ocso/db';
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
 * anywhere can check — and never because the maker just disabled the others
 * (identityBootstrapProblem).
 */

type Checker = { userId: string; teamIds: readonly string[]; permissions: ReadonlySet<PermissionName> };
type Facts = Pick<ProposalRow, 'objectId' | 'makerId'> & Partial<Pick<ProposalRow, 'payload'>>;

/** How long a disabled checker still counts as "someone who could check" for bootstrap purposes. */
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
 * A bootstrap self-approval of an identity change is refused while another holder of approvals.check.permissions
 * was disabled recently: disabling is a stop anyone with users.manage may do at once, and it must not manufacture
 * the "nobody else can check" that lets the maker approve their own access changes (or a new checker of their
 * choosing). The one exception brings a checker back: re-enabling a disabled holder of the check permission.
 */
export async function identityBootstrapProblem(tx: DbOrTx, p: Pick<ProposalRow, 'bootstrap' | 'objectKind' | 'objectId' | 'makerId' | 'action'>): Promise<ApprovalProblem | null> {
  if (!p.bootstrap) return null;
  const disabled = (await checkHolders(tx, ['DISABLED'])).map((h) => h.id);
  if (p.objectKind === 'user' && p.action === 'ACTIVATE' && disabled.includes(p.objectId)) return null;
  const others = disabled.filter((id) => id !== p.makerId && id !== p.objectId);
  if (!others.length) return null;
  const since = sql`now() - make_interval(days => ${DISABLED_CHECKER_WINDOW_DAYS})`;
  const [recent] = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'user.disable'), eq(auditEvents.targetType, 'user'), inArray(auditEvents.targetId, others), gt(auditEvents.occurredAt, since)))
    .limit(1);
  if (!recent) return null;
  return {
    code: 'bootstrap_checker_disabled',
    message: `Another checker of access changes was disabled in the last ${DISABLED_CHECKER_WINDOW_DAYS} days, so this cannot be self-approved: re-enable a checker (that alone may be self-approved) and have them check it.`,
  };
}
