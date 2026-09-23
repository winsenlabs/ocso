import {
  ALL_PERMISSIONS,
  PERMISSION_INFO,
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  isOverrideActive,
  type Permission,
  type PermissionGroup,
  type Role,
  type UserStatus,
} from '@ocso/auth';
import type { OverrideRow, UserRights } from './state.js';

export interface CatalogueEntry {
  permission: Permission;
  label: string;
  group: PermissionGroup;
  description: string;
  /** Presets that include it. */
  presets: Role[];
}

/** GET /v1/permissions/catalogue: every permission, in catalogue order. */
export function permissionCatalogue(): CatalogueEntry[] {
  return ALL_PERMISSIONS.map((permission) => ({
    permission,
    ...PERMISSION_INFO[permission],
    presets: ROLES.filter((r) => ROLE_PERMISSIONS[r].has(permission)),
  }));
}

export interface PersonRef {
  id: string;
  name: string;
}

export type PermissionSource =
  | { kind: 'PRESET'; preset: Role }
  | { kind: 'GRANT'; overrideId: string; expiresAt: string | null; grantedBy: PersonRef | null; reason: string; proposalId: string | null; createdAt: string };

export interface EffectivePermissionView {
  permission: Permission;
  label: string;
  group: PermissionGroup;
  description: string;
  /** Held now (false only for a preset permission a revoke removes). */
  active: boolean;
  sources: PermissionSource[];
  revoked: { overrideId: string; revokedBy: PersonRef | null; reason: string; createdAt: string } | null;
}

export interface OverrideView {
  id: string;
  permission: Permission;
  label: string;
  effect: 'GRANT' | 'REVOKE';
  expiresAt: string | null;
  /** Expired grants stay listed (expiry is computed, never swept) until someone clears them. */
  expired: boolean;
  reason: string;
  proposalId: string | null;
  createdBy: PersonRef | null;
  createdAt: string;
}

export interface UserPermissionsView {
  userId: string;
  preset: Role;
  presetLabel: string;
  status: UserStatus;
  effective: EffectivePermissionView[];
  overrides: OverrideView[];
}

/** Effective permissions with where each came from (GET /v1/users/:id/permissions). */
export function userPermissionsView(rights: UserRights, people: ReadonlyMap<string, string>, now: Date = new Date()): UserPermissionsView {
  const person = (id: string | null): PersonRef | null => (id ? { id, name: people.get(id) ?? 'Unknown user' } : null);
  const active = rights.overrides.filter((o) => isOverrideActive(o, now));
  const byPermission = new Map<Permission, OverrideRow>(active.map((o) => [o.permission, o]));
  const preset = ROLE_PERMISSIONS[rights.role];
  const effective: EffectivePermissionView[] = [];
  for (const permission of ALL_PERMISSIONS) {
    const override = byPermission.get(permission);
    const inPreset = preset.has(permission);
    if (!inPreset && override?.effect !== 'GRANT') continue;
    const sources: PermissionSource[] = [];
    if (inPreset) sources.push({ kind: 'PRESET', preset: rights.role });
    if (override?.effect === 'GRANT') {
      sources.push({
        kind: 'GRANT',
        overrideId: override.id,
        expiresAt: override.expiresAt?.toISOString() ?? null,
        grantedBy: person(override.createdBy),
        reason: override.reason,
        proposalId: override.proposalId,
        createdAt: override.createdAt.toISOString(),
      });
    }
    const revoke = override?.effect === 'REVOKE' ? override : null;
    effective.push({
      permission,
      ...PERMISSION_INFO[permission],
      active: !revoke,
      sources,
      revoked: revoke ? { overrideId: revoke.id, revokedBy: person(revoke.createdBy), reason: revoke.reason, createdAt: revoke.createdAt.toISOString() } : null,
    });
  }
  return {
    userId: rights.userId,
    preset: rights.role,
    presetLabel: ROLE_LABELS[rights.role],
    status: rights.status,
    effective,
    overrides: rights.overrides.map((o) => ({
      id: o.id,
      permission: o.permission,
      label: PERMISSION_INFO[o.permission].label,
      effect: o.effect,
      expiresAt: o.expiresAt?.toISOString() ?? null,
      expired: !isOverrideActive(o, now),
      reason: o.reason,
      proposalId: o.proposalId,
      createdBy: person(o.createdBy),
      createdAt: o.createdAt.toISOString(),
    })),
  };
}
