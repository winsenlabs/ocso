import 'server-only';
import { PERMISSION_GROUPS, ROLES, isPermission, type Permission } from '@ocso/auth';
import { z } from 'zod';
import { api } from './client';
import { ProposalRefSchema, USER_STATUSES } from './users';

/** A catalogued permission name; names this web build does not know are dropped (deploy skew). */
const PermissionName = z.custom<Permission>((v) => typeof v === 'string' && isPermission(v));
const Person = z.object({ id: z.string(), name: z.string() }).nullable();

/** GET /v1/permissions/catalogue. */
const CatalogueEntrySchema = z.object({
  permission: z.string(),
  label: z.string(),
  group: z.enum(PERMISSION_GROUPS),
  description: z.string(),
  presets: z.array(z.enum(ROLES)),
});
export type CatalogueEntry = z.infer<typeof CatalogueEntrySchema> & { permission: Permission };

const SourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PRESET'), preset: z.enum(ROLES) }),
  z.object({
    kind: z.literal('GRANT'),
    overrideId: z.string(),
    expiresAt: z.string().nullable(),
    grantedBy: Person,
    reason: z.string(),
    proposalId: z.string().nullable(),
    createdAt: z.string(),
  }),
]);
export type PermissionSource = z.infer<typeof SourceSchema>;

const EffectiveSchema = z.object({
  permission: PermissionName,
  label: z.string(),
  group: z.enum(PERMISSION_GROUPS),
  description: z.string(),
  active: z.boolean(),
  sources: z.array(SourceSchema),
  revoked: z.object({ overrideId: z.string(), revokedBy: Person, reason: z.string(), createdAt: z.string() }).nullable(),
});
export type EffectivePermission = z.infer<typeof EffectiveSchema>;

const OverrideSchema = z.object({
  id: z.string(),
  permission: PermissionName,
  label: z.string(),
  effect: z.enum(['GRANT', 'REVOKE']),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  reason: z.string(),
  proposalId: z.string().nullable(),
  createdBy: Person,
  createdAt: z.string(),
});
export type PermissionOverrideView = z.infer<typeof OverrideSchema>;

/** Rows naming a permission this web build does not know are dropped rather than failing the page. */
const keepValid = <S extends z.ZodType>(schema: S) =>
  z.array(z.unknown()).transform((rows) =>
    rows.flatMap((row) => {
      const parsed = schema.safeParse(row);
      return parsed.success ? [parsed.data as z.infer<S>] : [];
    }),
  );

/** GET /v1/users/:id/permissions: effective permissions with where each came from. */
const UserPermissionsSchema = z.object({
  userId: z.string(),
  preset: z.enum(ROLES),
  presetLabel: z.string(),
  status: z.enum(USER_STATUSES),
  effective: keepValid(EffectiveSchema),
  overrides: keepValid(OverrideSchema),
});
export type UserPermissions = z.infer<typeof UserPermissionsSchema>;

export type PermissionOp = { op: 'GRANT'; permission: Permission; expiresAt: string | null } | { op: 'REVOKE' | 'CLEAR'; permission: Permission };

export interface PermissionChangeRequest {
  preset?: (typeof ROLES)[number];
  changes: PermissionOp[];
  reason: string;
  approval?: { checkerId: string; reason?: string } | { bootstrap: true };
}

/**
 * 200: applied at once (reductions, or the whole change when nothing widens access). 202: the widening part was
 * proposed; any reductions in the same request applied anyway. 409 approval_required is thrown as an ApiError.
 */
const ChangeResultSchema = z.object({
  applied: z.boolean(),
  direction: z.enum(['INCREASE', 'DECREASE', 'NONE']),
  lost: z.array(z.string()),
  teamsRemoved: z.array(z.string()),
  sessionsEnded: z.number(),
  proposal: ProposalRefSchema.nullable(),
  gained: z.array(z.string()),
  teamsAdded: z.array(z.string()),
});
export type PermissionChangeResult = z.infer<typeof ChangeResultSchema>;

export async function getPermissionCatalogue(): Promise<CatalogueEntry[]> {
  const rows = await api.get('/v1/permissions/catalogue', z.array(CatalogueEntrySchema));
  return rows.filter((r): r is CatalogueEntry => isPermission(r.permission));
}

export function getUserPermissions(userId: string): Promise<UserPermissions> {
  return api.get(`/v1/users/${encodeURIComponent(userId)}/permissions`, UserPermissionsSchema);
}

export function changeUserPermissions(userId: string, request: PermissionChangeRequest): Promise<PermissionChangeResult> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/permission-changes`, request, ChangeResultSchema);
}
