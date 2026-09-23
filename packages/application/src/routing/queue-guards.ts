import { and, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, ErrorCategory, conflict, notFound, validation } from '@ocso/domain';
import { agentTeams, queueTeams, queues, routerVersions, routers, virtualAgents, type DbOrTx } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import type { ApprovalProblem } from '../approvals/contract.js';

/**
 * Governance of queue writes (PM/research/11 §4, ADR-026) until the queue
 * approval descriptor lands (wave 2):
 * - team scope: a person changes only queues their teams serve or whose
 *   agent their teams own (or with no agent yet), unlinks only their own
 *   teams, and names only agents their teams own;
 * - live queues: on a queue customers can reach (an ACTIVE router's version
 *   names it, or a reachable queue transfers to it) changing its agent,
 *   adding teams or adding transfer targets changes who answers customers,
 *   so it is an approval (409 approval_required); removing a transfer target
 *   or unlinking your team is a stop and never gated; clearing the agent is
 *   refused while an active router routes to the queue.
 */

/** Active router versions' queue references (fallback and rules), as text. */
const ROUTED_QUEUE_IDS = sql`SELECT ref FROM ${routers} r JOIN ${routerVersions} v ON v.id = r.active_version_id,
    LATERAL (SELECT v.definition ->> 'fallbackQueueId' AS ref UNION ALL SELECT x ->> 'queueId' FROM jsonb_array_elements(COALESCE(v.definition -> 'rules', '[]'::jsonb)) AS x) refs
   WHERE r.status = 'ACTIVE'`;

/**
 * What live routing that depends on this queue: the active routers that route
 * to it, and whether customers can reach it at all — routed to directly, or a
 * transfer target of a queue that is (transitively).
 */
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
  const reached = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE live(id) AS (
      SELECT q.id FROM ${queues} q WHERE q.id::text IN (${ROUTED_QUEUE_IDS})
      UNION
      SELECT t.id FROM live JOIN ${queues} s ON s.id = live.id CROSS JOIN LATERAL unnest(s.transfer_target_ids) AS t(id)
    )
    SELECT id FROM live WHERE id = ${queueId}::uuid LIMIT 1`);
  return { routers: [], live: reached.rows.length > 0 };
}

/** 409 until the approval spine accepts `approval` for queues (wave 2 registers the descriptor). */
export const queueApprovalRequired = (queueId: string, fields: readonly string[]): DomainError =>
  new DomainError(ErrorCategory.CONFLICT, 'approval_required', `Changing ${fields.join(', ')} of a queue live routing uses needs approval: name a checker and give a reason.`, {
    objectKind: 'queue',
    objectId: queueId,
    action: 'UPDATE',
    fields,
  });

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

/**
 * Changes to a queue live routing uses: 409 approval_required for changes
 * that widen who answers (agent, added teams, added transfer targets); a
 * conflict for clearing the agent of a queue an active router routes to.
 */
export async function assertLiveQueueChange(
  tx: DbOrTx,
  queue: { id: string; agentId: string | null; transferTargetIds: readonly string[] },
  change: { agentId?: string | null | undefined; addedTeams: readonly string[]; transferTargetIds?: readonly string[] | undefined },
): Promise<void> {
  const agentChanged = change.agentId !== undefined && change.agentId !== queue.agentId;
  const addedTargets = (change.transferTargetIds ?? []).filter((t) => !queue.transferTargetIds.includes(t));
  if (!agentChanged && !change.addedTeams.length && !addedTargets.length) return;
  const refs = await queueLiveReferences(tx, queue.id);
  if (!refs.live) return;
  if (agentChanged && change.agentId === null && refs.routers.length) {
    throw conflict('queue_routed', `Routers ${refs.routers.join(', ')} route to this queue: route them elsewhere before removing its agent (pause the agent to stop it answering).`);
  }
  const fields = [...(agentChanged ? ['agent'] : []), ...(change.addedTeams.length ? ['teams'] : []), ...(addedTargets.length ? ['transfer targets'] : [])];
  throw queueApprovalRequired(queue.id, fields);
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
