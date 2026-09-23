import { sql, type SQL } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import type { AuditScopeFilter } from '@ocso/audit-store';
import { auditEvents } from '@ocso/db';

/**
 * Shared operational configuration every audit reader may see changes to.
 * Channels and their message templates belong to no team (routers decide who
 * serves a channel's customers), so, like routers, their changes are shared;
 * their audit payloads never hold secrets (sanitizeForAudit, secret refs only).
 */
export const SHARED_AUDIT_TARGETS: readonly string[] = ['queue', 'sla_policy', 'team', 'router', 'channel', 'message_template'];

/**
 * Which audit events a reader may see (docs/15 §7, ADR-026, ADR-032).
 * `audit.read_all` (Tech) sees everything (null). Everyone else sees events
 * they performed, events that concern one of their teams — `team_ids`, the
 * target's teams ∪ the actor's teams at write time (auditTeams): teammates'
 * actions, changes to their teams' agents and those agents' prompts, rules,
 * corrections and evaluations, their teams' conversations, tool calls, users
 * and approvals — and changes to shared queue/SLA/team/router/channel
 * configuration.
 * The filter is data, not SQL, so every audit store driver can apply it.
 */
export function auditScope(principal: Principal): AuditScopeFilter {
  if (can(principal, Permission.AUDIT_READ_ALL)) return null;
  return { actorId: principal.userId, teamIds: [...principal.teamIds], sharedTargetTypes: SHARED_AUDIT_TARGETS };
}

/** The same filter over the main database's `audit_events` (the outbox and local window). */
export function auditScopeSql(scope: AuditScopeFilter): SQL | null {
  if (!scope) return null;
  const teams = scope.teamIds.length ? sql`${auditEvents.teamIds} && ARRAY[${sql.join(scope.teamIds.map((t) => sql`${t}::uuid`), sql`, `)}]` : sql`false`;
  const shared = scope.sharedTargetTypes.length ? sql`${auditEvents.targetType} IN (${sql.join(scope.sharedTargetTypes.map((t) => sql`${t}`), sql`, `)})` : sql`false`;
  return sql`(${auditEvents.actorId} = ${scope.actorId} OR ${teams} OR ${shared})`;
}
