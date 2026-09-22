import { Permission, can, type Principal } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';
import { isPersonal, type ConnectionRow } from './records.js';

/**
 * Service-level RBAC for MCP connections (build rule §14). Controllers check
 * the route permission too; these add the resource rules: personal
 * connections belong to their owner, and only the owner may use them.
 */

export function requirePermission(actor: ActorContext, permission: Permission): Principal {
  const principal = actor.principal;
  if (!principal) throw forbidden(permission, 'requires a signed-in user');
  if (!can(principal, permission)) throw forbidden(permission, `role ${principal.role} lacks ${permission}`);
  return principal;
}

function isOwner(principal: Principal, row: ConnectionRow): boolean {
  return row.ownerUserId === principal.userId && can(principal, Permission.MCP_CONNECT_PERSONAL);
}

/** View a connection and its tools. */
export function assertCanView(actor: ActorContext, row: ConnectionRow): Principal {
  if (!isPersonal(row)) return requirePermission(actor, Permission.MCP_READ);
  const principal = requirePermission(actor, Permission.MCP_CONNECT_PERSONAL);
  if (isOwner(principal, row) || can(principal, Permission.MCP_READ)) return principal;
  throw forbidden(Permission.MCP_CONNECT_PERSONAL, 'personal connection belongs to another user');
}

/**
 * Discover, authenticate and health-check. Personal connections carry their
 * owner's credentials, so only the owner may operate them — not even an admin.
 */
export function assertCanOperate(actor: ActorContext, row: ConnectionRow): Principal {
  if (!isPersonal(row)) return requirePermission(actor, Permission.MCP_MANAGE);
  const principal = requirePermission(actor, Permission.MCP_CONNECT_PERSONAL);
  if (!isOwner(principal, row)) throw forbidden(Permission.MCP_CONNECT_PERSONAL, 'personal connection belongs to another user');
  return principal;
}

/** Classify tools, approve, disable/enable: shared connections and templates only (personal ones inherit). */
export function assertCanAdminister(actor: ActorContext, row: ConnectionRow): Principal {
  const principal = requirePermission(actor, Permission.MCP_MANAGE);
  if (isPersonal(row)) throw forbidden(Permission.MCP_MANAGE, 'personal connections inherit their template classification');
  return principal;
}

/** Delete: the owner, or an admin revoking someone's personal connection. */
export function assertCanDelete(actor: ActorContext, row: ConnectionRow): Principal {
  if (!isPersonal(row)) return requirePermission(actor, Permission.MCP_MANAGE);
  const principal = actor.principal;
  if (principal && (isOwner(principal, row) || can(principal, Permission.MCP_MANAGE))) return principal;
  throw forbidden(Permission.MCP_CONNECT_PERSONAL, 'personal connection belongs to another user');
}
