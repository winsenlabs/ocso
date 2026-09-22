import { sql, type SQL } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { alertRules, auditEvents, conversations, escalationRules, evaluationRuns, promptCorrections, promptVersions, teamMembers } from '@ocso/db';
import { readableAgentsSql } from '../agents/access.js';
import { conversationScope, type VisibilityPolicy } from '../conversations/access.js';

/** Shared operational configuration every CS Lead may see changes to. */
const SHARED_TARGETS = ['queue', 'sla_policy', 'team'];

/**
 * Which audit events a reader may see (docs/15 §7, ADR-026). `audit.read_all`
 * (Tech Admin) sees everything. Everyone else sees: their own and their
 * teammates' actions; changes to agents they can read and to those agents'
 * prompts, escalation rules, corrections, evaluations and business alert
 * rules; events on conversations they can open; changes to users in their
 * teams; and shared queue/SLA/team configuration.
 */
export function auditScope(principal: Principal, policy: VisibilityPolicy): SQL | null {
  if (can(principal, Permission.AUDIT_READ_ALL)) return null;
  const teamIds = [...principal.teamIds];
  const teammates = teamIds.length
    ? sql`SELECT ${teamMembers.userId}::text FROM ${teamMembers} WHERE ${teamMembers.teamId} IN (${sql.join(teamIds.map((t) => sql`${t}::uuid`), sql`, `)})`
    : sql`SELECT NULL::text WHERE false`;
  const agents = readableAgentsSql(principal) ?? sql`SELECT NULL::uuid WHERE false`;
  const convScope = conversationScope(principal, policy);
  const visibleConversations = sql`SELECT ${conversations.id}::text FROM ${conversations}${convScope ? sql` WHERE ${convScope}` : sql``}`;
  const target = (type: string, ids: SQL) => sql`(${auditEvents.targetType} = ${type} AND ${auditEvents.targetId} IN (${ids}))`;
  return sql`(
    ${auditEvents.actorId} = ${principal.userId}
    OR ${auditEvents.actorId} IN (${teammates})
    OR ${target('agent', sql`SELECT id::text FROM (${agents}) a(id)`)}
    OR ${target('prompt_version', sql`SELECT ${promptVersions.id}::text FROM ${promptVersions} WHERE ${promptVersions.agentId} IN (${agents})`)}
    OR ${target('escalation_rule', sql`SELECT ${escalationRules.id}::text FROM ${escalationRules} WHERE ${escalationRules.agentId} IS NULL OR ${escalationRules.agentId} IN (${agents})`)}
    OR ${target('prompt_correction', sql`SELECT ${promptCorrections.id}::text FROM ${promptCorrections} WHERE ${promptCorrections.agentId} IN (${agents})`)}
    OR ${target('evaluation_run', sql`SELECT ${evaluationRuns.id}::text FROM ${evaluationRuns} WHERE ${evaluationRuns.agentId} IN (${agents})`)}
    OR ${target('alert_rule', sql`SELECT ${alertRules.id}::text FROM ${alertRules} WHERE ${alertRules.kind} = 'BUSINESS' AND (${alertRules.agentId} IS NULL OR ${alertRules.agentId} IN (${agents}))`)}
    OR ${target('conversation', visibleConversations)}
    OR ${target('user', teammates)}
    OR ${auditEvents.targetType} IN (${sql.join(SHARED_TARGETS.map((t) => sql`${t}`), sql`, `)})
  )`;
}
