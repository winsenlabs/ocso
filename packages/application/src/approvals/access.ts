import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { APPROVAL_CHECK_PERMISSIONS, Permission, can, effectivePermissions, type Principal } from '@ocso/auth';
import { approvalProposals, teamMembers, users, type DbOrTx } from '@ocso/db';
import { forbidden, type ApprovalAction } from '@ocso/domain';
import { recentCheckerLosses } from '../identity/approval/eligibility.js';
import { loadPrincipal } from '../identity/sessions.js';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';

/**
 * Who sees, checks and reassigns proposals (PM/research/11 §4.3, 11b
 * "permissions"). Rules are permissions and team membership, never presets.
 */

export const holdsAnyCheckPermission = (principal: Principal): boolean => APPROVAL_CHECK_PERMISSIONS.some((p) => can(principal, p));

const uuidArray = (ids: readonly string[]): SQL => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;

/**
 * Proposals a principal may list and open. `approvals.reassign_any` → every
 * proposal (null). Otherwise their own (as maker or checker), those of their
 * teams, and platform-wide ones (`team_ids = '{}'`) only when they hold a
 * check permission — a Service member never sees platform proposals.
 */
export function approvalScope(principal: Principal): SQL | null {
  if (can(principal, Permission.APPROVALS_REASSIGN_ANY)) return null;
  const me = principal.userId;
  const branches: SQL[] = [sql`${approvalProposals.makerId} = ${me}`, sql`${approvalProposals.checkerId} = ${me}`];
  if (principal.teamIds.length) branches.push(sql`${approvalProposals.teamIds} && ${uuidArray(principal.teamIds)}`);
  if (holdsAnyCheckPermission(principal)) branches.push(sql`${approvalProposals.teamIds} = '{}'::uuid[]`);
  return sql`(${sql.join(branches, sql` OR `)})`;
}

/** The named checker holding the kind's check permission, who is not the maker, and the proposal is open. */
export function mayCheck(principal: Principal, d: ApprovalDescriptor, p: Pick<ProposalRow, 'status' | 'makerId' | 'checkerId'>): boolean {
  return p.status === 'SUBMITTED' && can(principal, d.checkPermission) && p.checkerId === principal.userId && p.makerId !== principal.userId;
}

/** The maker holds the right to propose this action (the descriptor's mayMake, else its makePermission). */
export function canMake(principal: Principal, d: ApprovalDescriptor, action: ApprovalAction): boolean {
  return d.mayMake ? d.mayMake(principal, action) : can(principal, d.makePermission(action));
}

/** 403 unless the maker may propose this action. */
export function assertCanMake(principal: Principal, d: ApprovalDescriptor, action: ApprovalAction): void {
  if (!canMake(principal, d, action)) throw forbidden(d.makePermission(action), `${principal.displayName} cannot propose this ${d.label.toLowerCase()} change`);
}

/** Reassigning needs approvals.reassign_any or the kind's own check permission. */
export function mayReassign(principal: Principal, d: ApprovalDescriptor): boolean {
  return can(principal, Permission.APPROVALS_REASSIGN_ANY) || can(principal, d.checkPermission);
}

/** An ACTIVE user as the approval spine sees them: effective permissions and teams (null when not ACTIVE). */
export async function loadPerson(tx: DbOrTx, userId: string): Promise<Principal | null> {
  return loadPrincipal(tx, userId, 'SYSTEM');
}

export type ProposalFacts = Pick<ProposalRow, 'makerId' | 'teamIds'> & Partial<ProposalRow>;

/**
 * Default eligibility (§4.3): ACTIVE, holds the check permission, is not the
 * maker, and the proposal is platform-wide or shares a team with them. When no
 * one in the owning teams could check it (a team whose only Head is the maker),
 * any ACTIVE holder of the check permission may — the platform-wide fallback,
 * so a second person always checks while one exists anywhere, and reshaping a
 * team (owners, membership) can never manufacture a self-approval. A
 * descriptor's `eligible` replaces the team rule and the fallback.
 */
export async function isEligibleChecker(tx: DbOrTx, d: ApprovalDescriptor, proposal: ProposalFacts, person: Principal | null): Promise<boolean> {
  if (!person) return false;
  if (person.userId === proposal.makerId) return false;
  if (!can(person, d.checkPermission)) return false;
  if (d.eligible) {
    return d.eligible(tx, { userId: person.userId, teamIds: person.teamIds, permissions: effectivePermissions(person) }, proposal as ProposalRow);
  }
  if (proposal.teamIds.length === 0 || proposal.teamIds.some((t) => person.teamIds.includes(t))) return true;
  return (await teamCheckers(tx, d, proposal)).length === 0;
}

export interface CheckerCandidate {
  id: string;
  name: string;
  /** Null unless the caller holds users.read. */
  email: string | null;
  role: string | null;
}

type Row = { id: string; name: string; email: string; role: string };
const columns = { id: users.id, name: users.name, email: users.email, role: users.role };

async function judge(tx: DbOrTx, d: ApprovalDescriptor, proposal: ProposalFacts, rows: readonly Row[], rule: (p: Principal) => Promise<boolean> | boolean): Promise<Row[]> {
  const out: Row[] = [];
  for (const row of rows) {
    if (row.id === proposal.makerId) continue;
    const person = await loadPerson(tx, row.id);
    if (person && can(person, d.checkPermission) && (await rule(person))) out.push(row);
  }
  return out;
}

/** ACTIVE members of the proposal's teams (not the maker) who hold the check permission. */
async function teamCheckers(tx: DbOrTx, d: ApprovalDescriptor, proposal: ProposalFacts): Promise<Row[]> {
  const rows = await tx
    .selectDistinct(columns)
    .from(users)
    .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
    .where(and(eq(users.status, 'ACTIVE'), inArray(teamMembers.teamId, [...proposal.teamIds])))
    .orderBy(asc(users.name));
  return judge(tx, d, proposal, rows, () => true);
}

/**
 * Everyone who could check this proposal (never the maker), by the rules
 * above: the owning teams' checkers, else — for a team-scoped proposal with
 * none — every ACTIVE holder of the check permission. `exclude` drops people
 * after eligibility is decided (the current checker, on reassign).
 */
export async function eligibleCheckers(tx: DbOrTx, d: ApprovalDescriptor, proposal: ProposalFacts, exclude: readonly string[] = []): Promise<CheckerCandidate[]> {
  let found: Row[] = [];
  if (!d.eligible && proposal.teamIds.length > 0) found = await teamCheckers(tx, d, proposal);
  if (!found.length) {
    const everyone = await tx.select(columns).from(users).where(eq(users.status, 'ACTIVE')).orderBy(asc(users.name));
    found = await judge(tx, d, proposal, everyone, async (person) =>
      d.eligible ? d.eligible(tx, { userId: person.userId, teamIds: person.teamIds, permissions: effectivePermissions(person) }, proposal as ProposalRow) : true,
    );
  }
  return found.filter((r) => !exclude.includes(r.id));
}

/**
 * Bootstrap (§4.2): the maker holds the check permission (or the descriptor's bootstrapPermission) and nobody
 * else anywhere is eligible — and nobody else lost the check permission recently (disabled, demoted, revoked or a
 * grant expired: recentCheckerLosses), since those stops are immediate and must not manufacture "nobody else can
 * check". Identity kinds (approvals.check.permissions) make that refusal in their validate
 * (identityBootstrapProblem), which also lets re-enabling or restoring a checker be self-approved.
 */
export async function bootstrapAllowed(tx: DbOrTx, d: ApprovalDescriptor, proposal: ProposalFacts, maker: Principal, excludeAlso: readonly string[] = []): Promise<boolean> {
  if (!can(maker, d.checkPermission) && !(d.bootstrapPermission && can(maker, d.bootstrapPermission))) return false;
  if ((await eligibleCheckers(tx, d, { ...proposal, makerId: maker.userId }, excludeAlso)).length > 0) return false;
  if (d.checkPermission === Permission.APPROVALS_CHECK_PERMISSIONS) return true;
  return (await recentCheckerLosses(tx, d.checkPermission, [maker.userId])).length === 0;
}
