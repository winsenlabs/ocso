import { and, inArray, sql, type SQL } from 'drizzle-orm';
import { Permission, can, roleHasPermission, type Principal, type Role } from '@ocso/auth';
import type { AlertKind } from '@ocso/alerts';
import { alerts } from '@ocso/db';
import { forbidden } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';

/** Reading alerts of a kind (docs/99 §15: role-specific observability). */
export const ALERT_READ_PERMISSION: Readonly<Record<AlertKind, Permission>> = {
  TECHNICAL: Permission.ALERTS_TECHNICAL_READ,
  BUSINESS: Permission.ALERTS_BUSINESS_READ,
};

/** Managing rules of a kind. */
export const RULE_MANAGE_PERMISSION: Readonly<Record<AlertKind, Permission>> = {
  TECHNICAL: Permission.ALERT_RULES_TECHNICAL_MANAGE,
  BUSINESS: Permission.ALERT_RULES_BUSINESS_MANAGE,
};

const KINDS: readonly AlertKind[] = ['TECHNICAL', 'BUSINESS'];

export function requirePrincipal(actor: ActorContext, action: string): Principal {
  if (!actor.principal) throw forbidden(action, 'no principal');
  return actor.principal;
}

export function readableKinds(principal: Principal): AlertKind[] {
  return KINDS.filter((k) => can(principal, ALERT_READ_PERMISSION[k]));
}

export function manageableKinds(principal: Principal): AlertKind[] {
  return KINDS.filter((k) => can(principal, RULE_MANAGE_PERMISSION[k]));
}

export function roleCanReadKind(role: Role, kind: AlertKind): boolean {
  return roleHasPermission(role, ALERT_READ_PERMISSION[kind]);
}

export function assertCanManageKind(actor: ActorContext, kind: AlertKind): Principal {
  const principal = requirePrincipal(actor, RULE_MANAGE_PERMISSION[kind]);
  if (!can(principal, RULE_MANAGE_PERMISSION[kind])) {
    throw forbidden(RULE_MANAGE_PERMISSION[kind], `role ${principal.role} cannot manage ${kind.toLowerCase()} alert rules`);
  }
  return principal;
}

/**
 * Visibility of an alert row: the principal's role is in the alert's audience
 * AND the principal may read that kind. Both conditions, always.
 */
export function visibleAlertsWhere(principal: Principal, kinds: readonly AlertKind[] = readableKinds(principal)): SQL {
  if (!kinds.length) return sql`false`;
  return and(sql`${alerts.audienceRoles} @> ARRAY[${principal.role}]::text[]`, inArray(alerts.kind, [...kinds]))!;
}

export function canSeeAlert(principal: Principal, alert: { kind: AlertKind; audienceRoles: readonly string[] }): boolean {
  return alert.audienceRoles.includes(principal.role) && can(principal, ALERT_READ_PERMISSION[alert.kind]);
}
