import type { Permission } from './permissions.js';
import { ROLE_PERMISSIONS, type Role } from './roles.js';

/**
 * Per-user permissions (PM/research/11 §3.3–3.4): a user's rights are their
 * preset plus active grants minus active revokes, inside their teams. Pure and
 * browser-safe: the API classifies changes with it and the web explains them.
 */
export type OverrideEffect = 'GRANT' | 'REVOKE';

/** One uncleared row of user_permission_grants. Only GRANTs expire. */
export interface PermissionOverride {
  permission: Permission;
  effect: OverrideEffect;
  expiresAt: Date | null;
}

export type UserStatus = 'ACTIVE' | 'DISABLED' | 'PENDING_APPROVAL';

/** Everything that decides what a user may do and where. */
export interface RightsState {
  role: Role;
  status: UserStatus;
  teamIds: readonly string[];
  /** Uncleared overrides; expired ones may be present and count as absent. */
  overrides: readonly PermissionOverride[];
}

export type PermissionOp =
  | { op: 'GRANT'; permission: Permission; expiresAt: Date | null }
  | { op: 'REVOKE'; permission: Permission }
  | { op: 'CLEAR'; permission: Permission };

/** A change set: any mix of preset, status, memberships and overrides, classified as one. */
export interface RightsChange {
  role?: Role | undefined;
  status?: 'ACTIVE' | 'DISABLED' | undefined;
  teams?: { add?: readonly string[] | undefined; remove?: readonly string[] | undefined } | undefined;
  ops?: readonly PermissionOp[] | undefined;
}

export function isOverrideActive(override: Pick<PermissionOverride, 'expiresAt'>, now: Date = new Date()): boolean {
  return override.expiresAt === null || override.expiresAt.getTime() > now.getTime();
}

/** preset ∪ active grants − active revokes. A revoke wins over the preset; one permission has one override. */
export function computeEffectivePermissions(role: Role, overrides: readonly PermissionOverride[], now: Date = new Date()): Set<Permission> {
  const effective = new Set(ROLE_PERMISSIONS[role]);
  for (const o of overrides) {
    if (!isOverrideActive(o, now)) continue;
    if (o.effect === 'GRANT') effective.add(o.permission);
    else effective.delete(o.permission);
  }
  return effective;
}

/** What the user can do right now: nothing unless ACTIVE. */
export function effectiveOf(state: RightsState, now: Date = new Date()): Set<Permission> {
  return state.status === 'ACTIVE' ? computeEffectivePermissions(state.role, state.overrides, now) : new Set();
}

/** The state after a change set. Each op replaces whatever override the permission had; CLEAR removes it. */
export function applyRightsChange(state: RightsState, change: RightsChange): RightsState {
  const overrides = new Map(state.overrides.map((o) => [o.permission, o]));
  for (const op of change.ops ?? []) {
    if (op.op === 'CLEAR') overrides.delete(op.permission);
    else if (op.op === 'GRANT') overrides.set(op.permission, { permission: op.permission, effect: 'GRANT', expiresAt: op.expiresAt });
    else overrides.set(op.permission, { permission: op.permission, effect: 'REVOKE', expiresAt: null });
  }
  const remove = new Set(change.teams?.remove ?? []);
  const teamIds = [...new Set([...state.teamIds.filter((t) => !remove.has(t)), ...(change.teams?.add ?? [])])];
  return { role: change.role ?? state.role, status: change.status ?? state.status, teamIds, overrides: [...overrides.values()] };
}

export interface RightsClassification {
  /** INCREASE needs approval; DECREASE applies at once (stopping is never gated); NONE changes nothing. */
  direction: 'INCREASE' | 'DECREASE' | 'NONE';
  /** Permissions the user holds after but not before (now, as an ACTIVE user). */
  gained: Permission[];
  lost: Permission[];
  teamsAdded: string[];
  teamsRemoved: string[];
  /** Grants created or lengthened: rights for longer, even when today's set is unchanged. */
  extendedGrants: Permission[];
  /** DISABLED / PENDING_APPROVAL → ACTIVE. */
  activated: boolean;
  deactivated: boolean;
}

const activeGrantExpiry = (state: RightsState, permission: Permission, now: Date): Date | null | undefined => {
  const o = state.overrides.find((x) => x.permission === permission && x.effect === 'GRANT');
  return o && isOverrideActive(o, now) ? o.expiresAt : undefined;
};

/** A later (or no) expiry lasts longer. undefined = no active grant at all. */
function lastsLonger(after: Date | null, before: Date | null | undefined): boolean {
  if (before === undefined) return true;
  if (before === null) return false;
  return after === null || after.getTime() > before.getTime();
}

function sameOverrides(a: readonly PermissionOverride[], b: readonly PermissionOverride[]): boolean {
  const key = (o: PermissionOverride) => `${o.permission}|${o.effect}|${o.expiresAt?.getTime() ?? ''}`;
  const left = new Set(a.map(key));
  return a.length === b.length && b.every((o) => left.has(key(o)));
}

/**
 * Increase vs decrease (PM/research/11 §3.4): an increase is anything that lets
 * the user do more, somewhere new, or for longer — a permission the old
 * effective set lacks, a new team, a new or lengthened grant, or activation.
 * Everything else that changes something is a decrease.
 */
export function classifyRightsChange(before: RightsState, after: RightsState, now: Date = new Date()): RightsClassification {
  const wasActive = before.status === 'ACTIVE';
  const isActive = after.status === 'ACTIVE';
  // Compare as ACTIVE users so a preset change on someone disabled is judged by what it would give them.
  const old = computeEffectivePermissions(before.role, before.overrides, now);
  const next = computeEffectivePermissions(after.role, after.overrides, now);
  const gained = [...next].filter((p) => !old.has(p));
  const lost = [...old].filter((p) => !next.has(p));
  const teamsAdded = after.teamIds.filter((t) => !before.teamIds.includes(t));
  const teamsRemoved = before.teamIds.filter((t) => !after.teamIds.includes(t));
  const extendedGrants = after.overrides
    .filter((o) => o.effect === 'GRANT' && isOverrideActive(o, now) && lastsLonger(o.expiresAt, activeGrantExpiry(before, o.permission, now)))
    .map((o) => o.permission);
  const activated = !wasActive && isActive;
  const deactivated = wasActive && !isActive;
  // A never-approved user (PENDING_APPROVAL) is a draft: preset and memberships are edited freely, and the
  // user CREATE proposal binds the rights it approves (a snapshot). Once approved, a user stays governed
  // while DISABLED: an upgrade made while disabled is still an increase, so re-enabling cannot smuggle it in.
  // Grants are always approved.
  const governed = before.status !== 'PENDING_APPROVAL';
  const increase = activated || extendedGrants.length > 0 || (governed && (gained.length > 0 || teamsAdded.length > 0));
  const changed =
    before.role !== after.role ||
    before.status !== after.status ||
    teamsAdded.length > 0 ||
    teamsRemoved.length > 0 ||
    !sameOverrides(before.overrides, after.overrides);
  return {
    direction: increase ? 'INCREASE' : changed ? 'DECREASE' : 'NONE',
    gained,
    lost,
    teamsAdded,
    teamsRemoved,
    extendedGrants,
    activated,
    deactivated,
  };
}
