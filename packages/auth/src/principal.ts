import { forbidden } from '@ocso/domain';
import type { Permission } from './permissions.js';
import { ROLE_PERMISSIONS, type Role } from './roles.js';

/** How a request reached OCSO; recorded on audit events. */
export type AccessChannel = 'UI' | 'API' | 'INTERNAL_AGENT' | 'SYSTEM';

/** Authenticated human acting on OCSO. */
export interface Principal {
  readonly userId: string;
  /** The user's preset. Rules never branch on it; they check permissions. */
  readonly role: Role;
  readonly displayName: string;
  /** Teams the user belongs to; drives queue/conversation visibility. */
  readonly teamIds: readonly string[];
  readonly via: AccessChannel;
  readonly sessionId?: string | undefined;
  /**
   * Effective permissions: the preset plus active per-user grants minus active
   * revokes (PM/research/11 §3.3), computed by loadPrincipal. Absent on
   * principals built without the database (seeds, tests): the preset applies.
   */
  readonly permissions?: ReadonlySet<Permission> | undefined;
  /**
   * Set when Ask OCSO runs an API route for this user (PM/research/12 §6, via = INTERNAL_AGENT): the thread and
   * the confirmation card (a write) or the model's tool call (a read). Audit rows carry it.
   */
  readonly delegation?: InternalAgentDelegation | undefined;
}

/** Which Ask OCSO thread and card (or read call) a delegated request belongs to. */
export interface InternalAgentDelegation {
  readonly threadId: string;
  readonly cardId?: string | undefined;
  readonly callId?: string | undefined;
}

/** The principal's effective permissions. */
export function effectivePermissions(principal: Principal): ReadonlySet<Permission> {
  return principal.permissions ?? ROLE_PERMISSIONS[principal.role];
}

export function can(principal: Principal, permission: Permission): boolean {
  return effectivePermissions(principal).has(permission);
}

/** Throws a typed authorization error when the principal lacks the permission. */
export function assertCan(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    throw forbidden(permission, `${principal.displayName} lacks ${permission}`);
  }
}

/**
 * True when every permission in `rights` is also the principal's: nobody may
 * create or shape a colleague more powerful than themselves (users.manage_team).
 */
export function rightsWithin(rights: Iterable<Permission>, principal: Principal): boolean {
  const own = effectivePermissions(principal);
  for (const permission of rights) if (!own.has(permission)) return false;
  return true;
}

/** Derive a principal for an internal-agent action: same user, same RBAC. */
export function viaInternalAgent(principal: Principal): Principal {
  return { ...principal, via: 'INTERNAL_AGENT' };
}
