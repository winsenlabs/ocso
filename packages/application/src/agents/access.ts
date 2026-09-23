import { and, asc, eq, inArray, sql, type Column, type SQL } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { agentTeams, escalationRules, queueTeams, queues, teams, virtualAgents, type DbOrTx } from '@ocso/db';

/**
 * Team-scoped virtual-agent ownership (ADR-026). Agents are owned by teams
 * (`agent_teams`); people reach agents only through team membership
 * (`principal.teamIds`).
 *
 * - Manage (Lead: agents.manage, prompts.*, agent_tools.manage,
 *   escalation.manage, reviews/corrections/evaluations): the permission AND
 *   membership of one of the agent's owning teams.
 * - Read: agents.read_all (Tech admin) → every agent. Otherwise agents.read →
 *   agents owned by your teams; principals who cannot manage agents (Service members)
 *   additionally read agents reachable through their teams' queues (the agent's
 *   default queue, or one of its escalation rules targets the queue), so the
 *   workspace can show them.
 * - Anything outside the scope is reported as not found (404), never
 *   forbidden, so another team's agent does not leak its existence.
 * - An agent with no owning team is visible to agents.read_all holders only,
 *   until one is assigned (PUT /v1/agents/:id/owners).
 */

/** Empty id set (a subquery that returns no rows). */
const NO_AGENTS = sql`SELECT NULL::uuid WHERE false`;

/** Subquery: ids of agents owned by any of these teams. */
export function agentsOwnedBy(teamIds: readonly string[]): SQL {
  if (!teamIds.length) return NO_AGENTS;
  return sql`SELECT ${agentTeams.agentId} FROM ${agentTeams} WHERE ${inArray(agentTeams.teamId, [...teamIds])}`;
}

/** Subquery: ids of queues served by any of these teams. */
export function queuesServedBy(teamIds: readonly string[]): SQL {
  if (!teamIds.length) return sql`SELECT NULL::uuid WHERE false`;
  return sql`SELECT ${queueTeams.queueId} FROM ${queueTeams} WHERE ${inArray(queueTeams.teamId, [...teamIds])}`;
}

/** Subquery of agent ids the principal may read, or null when every agent is readable. */
export function readableAgentsSql(principal: Principal): SQL | null {
  if (can(principal, Permission.AGENTS_READ_ALL)) return null;
  if (!can(principal, Permission.AGENTS_READ) || !principal.teamIds.length) return NO_AGENTS;
  const owned = agentsOwnedBy(principal.teamIds);
  if (can(principal, Permission.AGENTS_MANAGE)) return owned;
  const served = queuesServedBy(principal.teamIds);
  return sql`${owned}
    UNION SELECT ${virtualAgents.id} FROM ${virtualAgents} WHERE ${virtualAgents.defaultQueueId} IN (${served})
    UNION SELECT ${queues.agentId} FROM ${queues} WHERE ${queues.agentId} IS NOT NULL AND ${queues.id} IN (${served})
    UNION SELECT ${escalationRules.agentId} FROM ${escalationRules} WHERE ${escalationRules.agentId} IS NOT NULL AND ${escalationRules.targetQueueId} IN (${served})`;
}

/** Subquery of agent ids the principal manages (owning-team membership); the action's permission is checked separately. */
export function manageableAgentsSql(principal: Principal): SQL {
  return agentsOwnedBy(principal.teamIds);
}

/** `column IN (readable agents)`, or undefined when unrestricted. For raw SQL pass e.g. sql`c.agent_id`. */
export function readableAgentFilter(principal: Principal, column: SQL | Column): SQL | undefined {
  const scope = readableAgentsSql(principal);
  return scope ? sql`${column} IN (${scope})` : undefined;
}

/** Readable agent ids, or null when unrestricted (for callers that filter in memory). */
export async function readableAgentIds(db: DbOrTx, principal: Principal): Promise<Set<string> | null> {
  const scope = readableAgentsSql(principal);
  if (!scope) return null;
  const rows = await db.select({ id: virtualAgents.id }).from(virtualAgents).where(sql`${virtualAgents.id} IN (${scope})`);
  return new Set(rows.map((r) => r.id));
}

async function assertInScope(db: DbOrTx, agentId: string, scope: SQL | null): Promise<void> {
  const [row] = await db
    .select({ id: virtualAgents.id })
    .from(virtualAgents)
    .where(and(eq(virtualAgents.id, agentId), scope ? sql`${virtualAgents.id} IN (${scope})` : undefined));
  if (!row) throw notFound('agent', agentId);
}

/** 404 unless the agent exists and the principal may read it. */
export function assertAgentReadable(db: DbOrTx, principal: Principal, agentId: string): Promise<void> {
  return assertInScope(db, agentId, readableAgentsSql(principal));
}

/** 404 unless the agent exists and one of its owning teams is one of the principal's teams. */
export function assertAgentManageable(db: DbOrTx, principal: Principal, agentId: string): Promise<void> {
  return assertInScope(db, agentId, manageableAgentsSql(principal));
}

export interface AgentTeamRef {
  id: string;
  name: string;
}

/** Owning teams per agent (name order). */
export async function owningTeams(db: DbOrTx, agentIds: readonly string[]): Promise<Map<string, AgentTeamRef[]>> {
  const out = new Map<string, AgentTeamRef[]>(agentIds.map((id) => [id, []]));
  if (!agentIds.length) return out;
  const rows = await db
    .select({ agentId: agentTeams.agentId, id: teams.id, name: teams.name })
    .from(agentTeams)
    .innerJoin(teams, eq(teams.id, agentTeams.teamId))
    .where(inArray(agentTeams.agentId, [...agentIds]))
    .orderBy(asc(teams.name));
  for (const r of rows) out.get(r.agentId)?.push({ id: r.id, name: r.name });
  return out;
}
