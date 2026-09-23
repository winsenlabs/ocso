import { assertCan, can, type Permission, type Principal } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';

/**
 * Service-level RBAC for model administration (build rule §14). Controllers
 * check too; this keeps the rule when services are called from elsewhere
 * (internal agent tools, scripts).
 */
export function authorize(actor: ActorContext, permission: Permission): Principal {
  if (!actor.principal) throw forbidden(permission, 'requires a signed-in user');
  assertCan(actor.principal, permission);
  return actor.principal;
}

/** Passes when the principal holds any one of the permissions. */
export function authorizeAny(actor: ActorContext, permissions: readonly Permission[]): Principal {
  const principal = actor.principal;
  if (!principal || !permissions.some((p) => can(principal, p))) {
    throw forbidden(permissions.join('|'), principal ? `role ${principal.role} lacks ${permissions.join(' or ')}` : 'requires a signed-in user');
  }
  return principal;
}

/** SQLSTATE of a Postgres error, possibly wrapped by the ORM (`cause` chain). */
function pgErrorCode(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

export const isUniqueViolation = (error: unknown): boolean => pgErrorCode(error) === '23505';
export const isForeignKeyViolation = (error: unknown): boolean => pgErrorCode(error) === '23503';
