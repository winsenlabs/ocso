import { Permission } from './permissions.js';
import { ROLE_PERMISSIONS, Role } from './roles.js';
import { applyRightsChange, classifyRightsChange, isOverrideActive, type PermissionOp, type RightsChange, type RightsClassification, type RightsState } from './rights.js';

/**
 * Permissions a preset can never hold through a grant, whatever the approval
 * (PM/research/11 §3.2: Tech never sees conversation content, edits prompts or
 * reads business analytics). Enforced when a change is proposed and again when
 * it applies, so neither a checker nor bootstrap self-approval can override it.
 */
export const NON_GRANTABLE_BY_PRESET: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  [Role.TECH]: new Set<Permission>([
    Permission.CONVERSATIONS_READ,
    Permission.CONVERSATIONS_READ_TEAM,
    Permission.CONVERSATIONS_CLAIM,
    Permission.CONVERSATIONS_TAKE_OVER,
    Permission.CONVERSATIONS_REPLY,
    Permission.CONVERSATIONS_NOTE,
    Permission.CONVERSATIONS_RETURN_TO_AI,
    Permission.CONVERSATIONS_RESOLVE,
    Permission.CONVERSATIONS_TRANSFER,
    Permission.CONVERSATIONS_ASSIGN,
    Permission.CUSTOMERS_READ,
    Permission.CUSTOMERS_MANAGE,
    Permission.TOOLS_EXECUTE_HUMAN,
    Permission.TOOLS_CONFIRM_SENSITIVE,
    Permission.COPILOT_USE,
    Permission.REVIEWS_MANAGE,
    Permission.CORRECTIONS_MANAGE,
    Permission.PROMPTS_EDIT,
    Permission.ANALYTICS_BUSINESS_READ,
  ]),
  [Role.HEAD]: new Set(),
  [Role.LEAD]: new Set(),
  [Role.SERVICE]: new Set(),
};

/** Uncleared GRANTs (expired or not) that the state's preset may never hold. */
export function forbiddenGrants(state: Pick<RightsState, 'role' | 'overrides'>): Permission[] {
  const blocked = NON_GRANTABLE_BY_PRESET[state.role];
  return state.overrides.filter((o) => o.effect === 'GRANT' && blocked.has(o.permission)).map((o) => o.permission);
}

const presetWithin = (next: Role, prev: Role) => [...ROLE_PERMISSIONS[next]].every((p) => ROLE_PERMISSIONS[prev].has(p));

/** Whether one op, on its own, can only take rights away (so it applies at once). */
function opReduces(before: RightsState, op: PermissionOp, roles: readonly Role[], now: Date): boolean {
  const current = before.overrides.find((o) => o.permission === op.permission);
  if (op.op === 'REVOKE') return true;
  if (op.op === 'CLEAR') {
    // Clearing a grant takes it away; clearing a revoke hands the preset's permission back.
    if (!current || current.effect === 'GRANT') return true;
    return !roles.some((r) => ROLE_PERMISSIONS[r].has(op.permission));
  }
  // A GRANT reduces only when it shortens a grant that is live now.
  if (!current || current.effect !== 'GRANT' || !isOverrideActive(current, now)) return false;
  if (current.expiresAt === null) return op.expiresAt !== null;
  return op.expiresAt !== null && op.expiresAt.getTime() <= current.expiresAt.getTime();
}

/** Split a change set into the part that only takes rights away and the rest. */
export function splitRightsChange(before: RightsState, change: RightsChange, now: Date = new Date()): { decrease: RightsChange; increase: RightsChange } {
  const role = change.role !== undefined && change.role !== before.role ? change.role : undefined;
  const roleDown = role !== undefined && presetWithin(role, before.role);
  const roles = role ? [before.role, role] : [before.role];
  const ops = change.ops ?? [];
  const reducing = ops.filter((op) => opReduces(before, op, roles, now));
  const widening = ops.filter((op) => !reducing.includes(op));
  const add = (change.teams?.add ?? []).filter((t) => !before.teamIds.includes(t));
  const remove = (change.teams?.remove ?? []).filter((t) => before.teamIds.includes(t));
  const status = change.status !== undefined && change.status !== before.status ? change.status : undefined;
  const decrease: RightsChange = {
    ...(roleDown ? { role } : {}),
    ...(status === 'DISABLED' ? { status } : {}),
    ...(remove.length ? { teams: { add: [], remove } } : {}),
    ...(reducing.length ? { ops: reducing } : {}),
  };
  const increase: RightsChange = {
    ...(role && !roleDown ? { role } : {}),
    ...(status === 'ACTIVE' ? { status } : {}),
    ...(add.length ? { teams: { add, remove: [] } } : {}),
    ...(widening.length ? { ops: widening } : {}),
  };
  // Defensive: a "decrease" that classifies as an increase goes to approval whole.
  if (classifyRightsChange(before, applyRightsChange(before, decrease), now).direction === 'INCREASE') return { decrease: {}, increase: change };
  return { decrease, increase };
}

export function isEmptyRightsChange(change: RightsChange): boolean {
  return change.role === undefined && change.status === undefined && !change.teams?.add?.length && !change.teams?.remove?.length && !change.ops?.length;
}

export interface RightsPlan {
  /** Applies at once: every reduction, plus the rest when the rest is not an increase (e.g. a draft user). */
  direct: RightsChange;
  /** Needs approval, judged against the state after `direct`; null when nothing does. */
  proposed: RightsChange | null;
  /** Classification of `direct` against the current state. */
  directClassification: RightsClassification;
  /** Classification of `proposed` against the state after `direct`. */
  proposedClassification: RightsClassification | null;
}

/**
 * How a change set is carried out (PM/research/11 §3.4: stopping is never
 * gated): the reductions apply at once even when the same request also widens
 * access; only the widening part waits for a checker.
 */
export function planRightsChange(before: RightsState, change: RightsChange, now: Date = new Date()): RightsPlan {
  const { decrease, increase } = splitRightsChange(before, change, now);
  const mid = applyRightsChange(before, decrease);
  const proposedClassification = classifyRightsChange(mid, applyRightsChange(mid, increase), now);
  if (proposedClassification.direction !== 'INCREASE') {
    return { direct: change, proposed: null, directClassification: classifyRightsChange(before, applyRightsChange(before, change), now), proposedClassification: null };
  }
  return { direct: decrease, proposed: increase, directClassification: classifyRightsChange(before, mid, now), proposedClassification };
}

/**
 * "Require MFA for roles" follows the rights, not only the preset: a user must
 * use a second factor when their preset is listed, or when a grant gives them
 * a permission that a listed preset holds and their own preset does not (a
 * Service member granted users.manage when Tech requires MFA). Without the
 * effective set (legacy callers) only the preset counts.
 */
export function mfaRequiredFor(role: Role, permissions: ReadonlySet<Permission> | undefined, requiredRoles: readonly Role[]): boolean {
  if (requiredRoles.includes(role)) return true;
  if (!permissions) return false;
  const own = ROLE_PERMISSIONS[role];
  for (const p of permissions) {
    if (!own.has(p) && requiredRoles.some((r) => ROLE_PERMISSIONS[r].has(p))) return true;
  }
  return false;
}
