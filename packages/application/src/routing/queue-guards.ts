import { and, eq, inArray, sql } from 'drizzle-orm';
import { notFound, validation } from '@ocso/domain';
import { agentTeams, queueTeams, queues, routerVersions, routers, virtualAgents, type DbOrTx } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import type { ApprovalProblem } from '../approvals/contract.js';

/**
 * Team scope of queue writes (PM/research/11 §4, ADR-026): a person changes
 * only queues their teams serve or whose agent their teams own (or with no
 * agent yet), unlinks only their own teams, and names only agents their teams
 * own. Which changes are proposals is the `queue` approval descriptor's rule
 * (queue-approval.ts); what live routing reaches is computed here.
 */

/** Active router versions' queue references (fallback and rules), as text. */
export const ROUTED_QUEUE_IDS = sql`SELECT ref FROM ${routers} r JOIN ${routerVersions} v ON v.id = r.active_version_id,
    LATERAL (SELECT v.definition ->> 'fallbackQueueId' AS ref UNION ALL SELECT x ->> 'queueId' FROM jsonb_array_elements(COALESCE(v.definition -> 'rules', '[]'::jsonb)) AS x) refs
   WHERE r.status = 'ACTIVE'`;

/**
 * Queues customers can reach, or that take handoffs from live agents: routed to by an active router, the
 * default queue of a LIVE/PAUSED agent, the target of an enabled escalation rule (global, or of a LIVE/PAUSED
 * agent), and — transitively — their transfer targets. One definition of "live" for gating (a change to a
 * live queue is always a proposal) and for the exception report (live without approval).
 */
export const LIVE_QUEUE_IDS = sql`
  WITH RECURSIVE live(id) AS (
    SELECT q.id FROM ${queues} q WHERE q.id::text IN (${ROUTED_QUEUE_IDS})
    UNION SELECT a.default_queue_id FROM virtual_agents a WHERE a.status IN ('LIVE','PAUSED') AND a.default_queue_id IS NOT NULL
    UNION SELECT r.target_queue_id FROM escalation_rules r LEFT JOIN virtual_agents a ON a.id = r.agent_id
           WHERE r.enabled AND r.target_queue_id IS NOT NULL AND (r.agent_id IS NULL OR a.status IN ('LIVE','PAUSED'))
    UNION SELECT t.id FROM live JOIN ${queues} s ON s.id = live.id CROSS JOIN LATERAL unnest(s.transfer_target_ids) AS t(id)
  )
  SELECT DISTINCT id FROM live`;

/** Whether the queue is live (LIVE_QUEUE_IDS). */
export async function isLiveQueue(tx: DbOrTx, queueId: string): Promise<boolean> {
  const rows = await tx.execute<{ live: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM (${LIVE_QUEUE_IDS}) l WHERE l.id = ${queueId}::uuid) AS live`);
  return Boolean(rows.rows[0]?.live);
}

/** The active routers that route to this queue, and whether it is live at all (LIVE_QUEUE_IDS). */
export async function queueLiveReferences(tx: DbOrTx, queueId: string): Promise<{ routers: string[]; live: boolean }> {
  const routerRows = await tx
    .select({ name: routers.name })
    .from(routers)
    .innerJoin(routerVersions, eq(routerVersions.id, routers.activeVersionId))
    .where(
      and(
        eq(routers.status, 'ACTIVE'),
        sql`${queueId} IN (SELECT ${routerVersions.definition} ->> 'fallbackQueueId' UNION ALL SELECT r ->> 'queueId' FROM jsonb_array_elements(COALESCE(${routerVersions.definition} -> 'rules', '[]'::jsonb)) AS r)`,
      ),
    );
  if (routerRows.length) return { routers: routerRows.map((r) => r.name).sort(), live: true };
  return { routers: [], live: await isLiveQueue(tx, queueId) };
}

async function teamsOf(tx: DbOrTx, queueId: string): Promise<string[]> {
  return (await tx.select({ teamId: queueTeams.teamId }).from(queueTeams).where(eq(queueTeams.queueId, queueId))).map((r) => r.teamId);
}

async function agentOwnedByTeams(tx: DbOrTx, agentId: string, teamIds: readonly string[]): Promise<boolean> {
  if (!teamIds.length) return false;
  const [row] = await tx.select({ agentId: agentTeams.agentId }).from(agentTeams).where(and(eq(agentTeams.agentId, agentId), inArray(agentTeams.teamId, [...teamIds]))).limit(1);
  return Boolean(row);
}

/**
 * 404 unless the queue is the principal's to change: one of their teams serves
 * it, or their teams own its agent (ADR-026: a Lead manages an agent through
 * its owning team, possibly staffing its queue with another team), or it has
 * no agent yet (it routes nothing until it does).
 */
export async function assertQueueInScope(tx: DbOrTx, principal: Principal, queue: { id: string; agentId: string | null }): Promise<string[]> {
  const current = await teamsOf(tx, queue.id);
  const mine = current.some((t) => principal.teamIds.includes(t));
  const agentMine = queue.agentId !== null && (await agentOwnedByTeams(tx, queue.agentId, principal.teamIds));
  // A queue without an agent routes nothing (activation requires one): still being set up, any queues.manage holder may edit it.
  const unserved = queue.agentId === null;
  if (!mine && !agentMine && !unserved) throw notFound('queue', queue.id);
  return current;
}

/** Another team's link is theirs: it may be added (staffing), never removed by someone outside that team. */
export function assertTeamChange(principal: Principal, before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const added = after.filter((t) => !before.includes(t));
  const removed = before.filter((t) => !after.includes(t));
  const foreign = removed.filter((t) => !principal.teamIds.includes(t));
  if (foreign.length) throw validation('queue_team_not_yours', 'You can unlink only teams you belong to', { teamIds: foreign });
  return { added, removed };
}

/** A queue's agent must be one the principal's teams own. */
export async function assertAgentAssignable(tx: DbOrTx, principal: Principal, agentId: string): Promise<void> {
  const [agent] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
  if (!agent || !(await agentOwnedByTeams(tx, agentId, principal.teamIds))) throw notFound('agent', agentId);
}

/** Agent delete blockers (the agent approval descriptor): it serves a queue an active router routes to. */
export async function routedQueueBlockers(tx: DbOrTx, agentId: string): Promise<ApprovalProblem[]> {
  const served = await tx.select({ id: queues.id, name: queues.name }).from(queues).where(eq(queues.agentId, agentId));
  const problems: ApprovalProblem[] = [];
  for (const q of served) {
    const refs = await queueLiveReferences(tx, q.id);
    if (refs.routers.length) problems.push({ code: 'agent_serves_routed_queue', message: `${q.name} is routed to by ${refs.routers.join(', ')}: give the queue another agent first.` });
  }
  return problems;
}
