import { forbidden } from '@ocso/domain';
import type { Permission } from './permissions.js';
import { roleHasPermission, type Role } from './roles.js';

/** How a request reached OCSO; recorded on audit events. */
export type AccessChannel = 'UI' | 'API' | 'INTERNAL_AGENT' | 'SYSTEM';

/** Authenticated human acting on OCSO. */
export interface Principal {
  readonly userId: string;
  readonly role: Role;
  readonly displayName: string;
  /** Teams the user belongs to; drives queue/conversation visibility. */
  readonly teamIds: readonly string[];
  readonly via: AccessChannel;
  readonly sessionId?: string | undefined;
}

export function can(principal: Principal, permission: Permission): boolean {
  return roleHasPermission(principal.role, permission);
}

/** Throws a typed authorization error when the principal lacks the permission. */
export function assertCan(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    throw forbidden(permission, `role ${principal.role} lacks ${permission}`);
  }
}

/** Derive a principal for an internal-agent action: same user, same RBAC. */
export function viaInternalAgent(principal: Principal): Principal {
  return { ...principal, via: 'INTERNAL_AGENT' };
}
