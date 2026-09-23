import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import type { ActorContext } from '../shared/context.js';

/**
 * The teams an audit event concerns (ADR-032): the target's teams ∪ the
 * actor's teams, stored on the row as `team_ids` so the audit store — another
 * database, which cannot join ours — can scope reads by team. Resolved at
 * write time; a later membership change does not move old events (the ADR
 * records the trade).
 *
 * Resolvers are SQL returning one `team_id uuid` column for a target id (run
 * only for uuid ids, so they may cast and use the primary key index). A
 * feature whose objects are team-owned registers its own target type
 * (`registerAuditTeamResolver`); unknown target types concern only the actor's
 * teams. migration 0026 backfilled existing rows with the same rules.
 */
export type AuditTeamResolver = (targetId: string) => SQL;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const byAgent = (table: string) => (targetId: string) =>
  sql`SELECT at.team_id FROM ${sql.identifier(table)} x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE x.id = ${targetId}::uuid`;

const RESOLVERS = new Map<string, AuditTeamResolver>([
  ['agent', (id) => sql`SELECT team_id FROM agent_teams WHERE agent_id = ${id}::uuid`],
  ['prompt_version', byAgent('prompt_versions')],
  ['escalation_rule', byAgent('escalation_rules')],
  ['prompt_correction', byAgent('prompt_corrections')],
  ['evaluation_run', byAgent('evaluation_runs')],
  ['alert_rule', byAgent('alert_rules')],
  [
    'conversation',
    (id) => sql`SELECT at.team_id FROM conversations x JOIN agent_teams at ON at.agent_id = x.agent_id WHERE x.id = ${id}::uuid
                UNION SELECT qt.team_id FROM conversations x JOIN queue_teams qt ON qt.queue_id = x.queue_id WHERE x.id = ${id}::uuid`,
  ],
  [
    'tool_call',
    (id) => sql`SELECT at.team_id FROM tool_calls tc JOIN conversations x ON x.id = tc.conversation_id JOIN agent_teams at ON at.agent_id = x.agent_id WHERE tc.id = ${id}::uuid
                UNION SELECT qt.team_id FROM tool_calls tc JOIN conversations x ON x.id = tc.conversation_id JOIN queue_teams qt ON qt.queue_id = x.queue_id WHERE tc.id = ${id}::uuid`,
  ],
  ['user', (id) => sql`SELECT team_id FROM team_members WHERE user_id = ${id}::uuid`],
  ['team', (id) => sql`SELECT id FROM teams WHERE id = ${id}::uuid`],
  ['queue', (id) => sql`SELECT team_id FROM queue_teams WHERE queue_id = ${id}::uuid`],
  ['approval', (id) => sql`SELECT unnest(team_ids) FROM approval_proposals WHERE id = ${id}::uuid`],
]);

/** Adds (or replaces) how a target type's teams are found; call at module load, before any write. */
export function registerAuditTeamResolver(targetType: string, resolver: AuditTeamResolver): void {
  RESOLVERS.set(targetType, resolver);
}

export async function auditTeams(tx: DbOrTx, targetType: string, targetId: string | null | undefined, actor: ActorContext): Promise<string[]> {
  const parts: SQL[] = [];
  const resolver = targetId && UUID.test(targetId) ? RESOLVERS.get(targetType) : undefined;
  if (resolver && targetId) parts.push(resolver(targetId));
  // A virtual agent acting (its tool calls, its handoffs) concerns the teams that own it.
  if (actor.system?.kind === 'AGENT' && UUID.test(actor.system.id)) parts.push(sql`SELECT team_id FROM agent_teams WHERE agent_id = ${actor.system.id}::uuid`);
  const own = actor.principal?.teamIds ?? [];
  if (!parts.length) return [...new Set(own)].sort();
  const { rows } = await tx.execute<{ team_id: string }>(sql`SELECT DISTINCT team_id::text AS team_id FROM (${sql.join(parts, sql` UNION `)}) t(team_id) WHERE team_id IS NOT NULL`);
  return [...new Set([...own, ...rows.map((r) => r.team_id)])].sort();
}
