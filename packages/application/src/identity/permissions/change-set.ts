import { Permission, ROLES, type PermissionOp, type RightsChange, type RightsState } from '@ocso/auth';
import { z } from 'zod';

/**
 * Wire and stored shapes of a per-user rights change (PM/research/11 §3.4–3.5).
 * `PermissionChangeSet` is what an approved `permission_change` proposal
 * applies (its payload): wave 2's descriptor parses it and calls
 * applyPermissionChangeSet.
 */
const PermissionName = z.enum(Permission);

/**
 * How the maker routes an increase to maker–checker (§4.1): a named checker,
 * or bootstrap self-approval when no other eligible checker exists.
 */
export const ApprovalChoice = z.union([
  z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500).optional() }).strict(),
  z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() }).strict(),
]);
export type ApprovalChoice = z.infer<typeof ApprovalChoice>;

export const PermissionOpInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('GRANT'), permission: PermissionName, expiresAt: z.iso.datetime({ offset: true }).nullable().default(null) }),
  z.object({ op: z.literal('REVOKE'), permission: PermissionName }),
  z.object({ op: z.literal('CLEAR'), permission: PermissionName }),
]);
export type PermissionOpInput = z.infer<typeof PermissionOpInput>;

const distinctPermissions = (ops: ReadonlyArray<{ permission: string }>) => new Set(ops.map((o) => o.permission)).size === ops.length;

/** POST /v1/users/:id/permission-changes. */
export const PermissionChangeInput = z
  .object({
    preset: z.enum(ROLES).optional(),
    changes: z.array(PermissionOpInput).max(50).default([]),
    reason: z.string().trim().min(3).max(500),
    approval: ApprovalChoice.optional(),
  })
  .refine((v) => v.preset !== undefined || v.changes.length > 0, { message: 'Change the preset or at least one permission', path: ['changes'] })
  .refine((v) => distinctPermissions(v.changes), { message: 'Each permission may appear once', path: ['changes'] });
export type PermissionChangeInput = z.input<typeof PermissionChangeInput>;

/**
 * The stored, replayable change set: what approval applies, against the user's
 * state at that moment. `makerId` is who proposed it: at activation the maker
 * rules are re-run against their rights then, and grant rows record them as
 * `created_by` (the checker is on the proposal).
 */
export const PermissionChangeSet = z.object({
  userId: z.uuid(),
  makerId: z.uuid().optional(),
  role: z.enum(ROLES).optional(),
  teams: z.object({ add: z.array(z.uuid()).max(200).default([]), remove: z.array(z.uuid()).max(200).default([]) }).optional(),
  ops: z.array(PermissionOpInput).max(50).default([]),
  reason: z.string().trim().min(3).max(500),
});
export type PermissionChangeSet = z.infer<typeof PermissionChangeSet>;

/** What a user CREATE / ACTIVATE approval binds: the rights the checker saw. Activation refuses any other state. */
export const UserRightsSnapshot = z.object({
  role: z.enum(ROLES),
  teamIds: z.array(z.uuid()),
  overrides: z.array(z.object({ permission: PermissionName, effect: z.enum(['GRANT', 'REVOKE']), expiresAt: z.iso.datetime({ offset: true }).nullable() })),
});
export type UserRightsSnapshot = z.infer<typeof UserRightsSnapshot>;

/** Payload of a `user` proposal (CREATE for a new user, ACTIVATE for re-enabling one). */
export const UserProposalPayload = z.object({ userId: z.uuid(), makerId: z.uuid(), rights: UserRightsSnapshot });
export type UserProposalPayload = z.infer<typeof UserProposalPayload>;

/** Canonical (sorted, ISO) snapshot of someone's rights, so equal rights compare and hash equal. */
export function userRightsSnapshot(state: Pick<RightsState, 'role' | 'teamIds' | 'overrides'>): UserRightsSnapshot {
  return {
    role: state.role,
    teamIds: [...state.teamIds].sort(),
    overrides: state.overrides
      .map((o) => ({ permission: o.permission, effect: o.effect, expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null }))
      .sort((a, b) => a.permission.localeCompare(b.permission)),
  };
}

export function sameUserRights(a: UserRightsSnapshot, b: UserRightsSnapshot): boolean {
  const norm = (s: UserRightsSnapshot) =>
    JSON.stringify({
      role: s.role,
      teamIds: [...s.teamIds].sort(),
      overrides: [...s.overrides].map((o) => ({ ...o, expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null })).sort((x, y) => x.permission.localeCompare(y.permission)),
    });
  return norm(a) === norm(b);
}

/** A rights change (role / teams / ops) as the stored change set. */
export function toChangeSet(userId: string, change: RightsChange, reason: string, makerId?: string): PermissionChangeSet {
  return {
    userId,
    ...(makerId ? { makerId } : {}),
    ...(change.role ? { role: change.role } : {}),
    ...(change.teams?.add?.length || change.teams?.remove?.length ? { teams: { add: [...(change.teams.add ?? [])], remove: [...(change.teams.remove ?? [])] } } : {}),
    ops: (change.ops ?? []).map((o) => (o.op === 'GRANT' ? { op: 'GRANT', permission: o.permission, expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null } : o)),
    reason,
  };
}

export function toPermissionOps(ops: readonly PermissionOpInput[]): PermissionOp[] {
  return ops.map((o) => (o.op === 'GRANT' ? { op: 'GRANT', permission: o.permission, expiresAt: o.expiresAt ? new Date(o.expiresAt) : null } : o));
}

export function toRightsChange(set: Pick<PermissionChangeSet, 'role' | 'teams' | 'ops'>): RightsChange {
  return { role: set.role, teams: set.teams, ops: toPermissionOps(set.ops) };
}
