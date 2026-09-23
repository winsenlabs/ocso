import { sql, type SQL } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import type { Db } from '@ocso/db';
import { queuesServedBy, readableAgentsSql } from '../agents/access.js';
import { conversationScope, type VisibilityPolicy } from '../conversations/access.js';
import { at, int, num, ratio } from './values.js';

/**
 * The live service flow on Home (HOME decision 3): channel → router → queue →
 * agent over the last 24 hours, counts only (no conversation content). Tech
 * sees the whole deployment; a Head or Lead sees the agents their teams own,
 * the queues their teams serve or those agents answer, the routers that route
 * to those queues and the channels on those routers. Conversation counts use
 * the conversation page's own scope (conversationScope) for a Head or Lead;
 * queue live figures (waiting, oldest, at risk) are the queue's own, as on the
 * queues page.
 */
export interface FlowChannel {
  id: string;
  name: string;
  kind: string;
  status: string;
  conversations24h: number;
  /** Why customers may not get through; absent when nothing is wrong. */
  problem?: string;
}

export interface FlowRouter {
  id: string;
  name: string;
  status: string;
  channelIds: string[];
  routed24h: number;
  /** Conversations still routing past the router's timeout (plus the sweep's grace). */
  stuck: number;
  /** Oldest stuck conversation's last routing activity (for "needs you"). Not part of the web contract. */
  stuckSince?: string;
}

export interface FlowQueue {
  id: string;
  name: string;
  routerIds: string[];
  agentId: string | null;
  waiting: number;
  oldestWaitSeconds: number | null;
  slaAtRisk: number;
}

export interface FlowAgent {
  id: string;
  name: string;
  status: string;
  queueIds: string[];
  conversations24h: number;
  containment: number | null;
  escalations24h: number;
}

export interface HomeFlow {
  channels: FlowChannel[];
  routers: FlowRouter[];
  queues: FlowQueue[];
  agents: FlowAgent[];
}

/** Minutes past a router's timeout before a routing conversation counts as stuck (the leader sweep runs every 60 s). */
export const ROUTING_STUCK_GRACE_MINUTES = 5;
/** Failed outbound deliveries in the last hour, with none delivered, that mark a channel as failing. */
export const CHANNEL_FAILING_MIN = 3;

export const WAITING_STATES = sql`('ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN')`;

/**
 * Waiting conversations (alias `c`, queue SLA policy alias `sp`) at or past their SLA's at-risk point:
 * the same rule as evaluateSla (elapsed fraction ≥ at_risk_fraction, or breached).
 */
export const slaAtRiskSql = (now: Date): SQL =>
  sql`(c.sla_due_at IS NOT NULL AND (c.sla_due_at <= ${at(now)} OR (c.waiting_since IS NOT NULL
      AND ${at(now)} >= c.waiting_since + (c.sla_due_at - c.waiting_since) * COALESCE(sp.at_risk_fraction, 0.75))))`;

export async function homeFlow(db: Db, principal: Principal, now: Date, policy: VisibilityPolicy): Promise<HomeFlow> {
  const since = new Date(now.getTime() - 86_400_000);
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const agentScope = readableAgentsSql(principal);
  // Tech (every agent) counts every conversation: counts only, never content. A Head or Lead: their conversation scope.
  const convScope: SQL = agentScope === null ? sql`true` : (conversationScope(principal, policy) ?? sql`true`);
  const [routerRows, channelRows, queueRows, agentRows, servedRows, channelCounts, routing, deliveries] = await Promise.all([
    db.execute<{ id: string; name: string; status: string; queue_ids: string[] | null }>(sql`
      SELECT r.id, r.name, r.status,
             ARRAY(SELECT DISTINCT x.qid FROM (
                     SELECT v.definition ->> 'fallbackQueueId' AS qid
                     UNION ALL SELECT rule ->> 'queueId' FROM jsonb_array_elements(COALESCE(v.definition -> 'rules', '[]'::jsonb)) AS rule
                   ) x WHERE x.qid IS NOT NULL) AS queue_ids
        FROM routers r
        LEFT JOIN router_versions v ON v.id = r.active_version_id
       ORDER BY r.name`),
    db.execute<{ id: string; name: string; kind: string; status: string; router_id: string | null; router_status: string | null }>(sql`
      SELECT ch.id, ch.name, ch.kind, ch.status, ch.router_id, r.status AS router_status
        FROM channels ch LEFT JOIN routers r ON r.id = ch.router_id
       ORDER BY ch.name`),
    db.execute<{ id: string; name: string; agent_id: string | null; waiting: number; oldest: Date | string | null; at_risk: number }>(sql`
      SELECT q.id, q.name, q.agent_id,
             count(c.id)::int AS waiting,
             min(c.waiting_since) AS oldest,
             count(c.id) FILTER (WHERE ${slaAtRiskSql(now)})::int AS at_risk
        FROM queues q
        LEFT JOIN sla_policies sp ON sp.id = q.sla_policy_id
        LEFT JOIN conversations c ON c.queue_id = q.id AND c.control_state IN ${WAITING_STATES}
       GROUP BY q.id, q.name, q.agent_id
       ORDER BY q.name`),
    db.execute<{ id: string; name: string; status: string; conversations: number; human_involved: number; escalations: number }>(sql`
      SELECT a.id, a.name, a.status,
             (SELECT count(*)::int FROM conversations c WHERE c.agent_id = a.id AND c.opened_at >= ${at(since)}) AS conversations,
             (SELECT count(*)::int FROM conversations c WHERE c.agent_id = a.id AND c.opened_at >= ${at(since)}
                AND EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id)) AS human_involved,
             (SELECT count(*)::int FROM handoffs h JOIN conversations c ON c.id = h.conversation_id
               WHERE c.agent_id = a.id AND h.trigger <> 'HUMAN_REQUEST' AND h.requested_at >= ${at(since)}) AS escalations
        FROM virtual_agents a
       ${agentScope ? sql`WHERE a.id IN (${agentScope})` : sql``}
       ORDER BY a.name`),
    agentScope ? db.execute<{ id: string }>(sql`SELECT s.id FROM (${queuesServedBy(principal.teamIds)}) AS s(id) WHERE s.id IS NOT NULL`) : Promise.resolve({ rows: [] }),
    db.execute<{ channel_id: string; n: number }>(sql`
      SELECT conversations.channel_id, count(*)::int AS n FROM conversations
       WHERE conversations.opened_at >= ${at(since)} AND conversations.channel_id IS NOT NULL AND ${convScope}
       GROUP BY conversations.channel_id`),
    db.execute<{ router_id: string; routed: number; stuck: number; stuck_since: Date | string | null }>(sql`
      WITH r AS (
        SELECT cr.router_id, cr.decided_at, conversations.control_state,
               (conversations.control_state = 'ROUTING' AND cr.phase <> 'DONE'
                 AND COALESCE(cr.awaiting_since, cr.updated_at) < ${at(now)}
                     - make_interval(mins => COALESCE((v.definition ->> 'timeoutMinutes')::int, 10) + ${ROUTING_STUCK_GRACE_MINUTES})) AS stuck,
               COALESCE(cr.awaiting_since, cr.updated_at) AS last_at
          FROM conversation_routing cr
          JOIN conversations ON conversations.id = cr.conversation_id
          LEFT JOIN router_versions v ON v.id = cr.router_version_id
         WHERE cr.router_id IS NOT NULL AND (cr.decided_at >= ${at(since)} OR conversations.control_state = 'ROUTING') AND ${convScope}
      )
      SELECT router_id, count(*) FILTER (WHERE decided_at >= ${at(since)})::int AS routed,
             count(*) FILTER (WHERE stuck)::int AS stuck, min(last_at) FILTER (WHERE stuck) AS stuck_since
        FROM r GROUP BY router_id`),
    db.execute<{ channel_id: string; failed: number; delivered: number }>(sql`
      SELECT i.channel_id,
             count(*) FILTER (WHERE i.delivery_status = 'FAILED')::int AS failed,
             count(*) FILTER (WHERE i.delivery_status IN ('SENT', 'DELIVERED', 'READ'))::int AS delivered
        FROM conversations c JOIN interactions i ON i.conversation_id = c.id
       WHERE c.last_interaction_at >= ${at(hourAgo)} AND i.created_at >= ${at(hourAgo)} AND i.direction = 'OUTBOUND' AND i.channel_id IS NOT NULL
       GROUP BY i.channel_id`),
  ]);

  const readableAgents = new Set(agentRows.rows.map((a) => a.id));
  const served = new Set(servedRows.rows.map((r) => r.id));
  const queueInScope = (q: { id: string; agent_id: string | null }) => agentScope === null || served.has(q.id) || (q.agent_id !== null && readableAgents.has(q.agent_id));
  const queues = queueRows.rows.filter(queueInScope);
  const queueIds = new Set(queues.map((q) => q.id));
  const routersIn = routerRows.rows.filter((r) => agentScope === null || (r.queue_ids ?? []).some((q) => queueIds.has(q)));
  const routerIds = new Set(routersIn.map((r) => r.id));
  const channelsIn = channelRows.rows.filter((c) => agentScope === null || (c.router_id !== null && routerIds.has(c.router_id)));

  const byChannel = new Map(channelCounts.rows.map((r) => [r.channel_id, int(r.n)]));
  const byRouter = new Map(routing.rows.map((r) => [r.router_id, r]));
  const failing = new Map(deliveries.rows.map((r) => [r.channel_id, r]));

  const channels: FlowChannel[] = channelsIn.map((c) => {
    const d = failing.get(c.id);
    let problem: string | undefined;
    if (c.status === 'ACTIVE' && (!c.router_id || c.router_status !== 'ACTIVE')) problem = c.router_id ? 'Its router is not live: customers are turned away' : 'No router: customers are turned away';
    else if (c.status === 'ACTIVE' && d && int(d.failed) >= CHANNEL_FAILING_MIN && int(d.delivered) === 0) problem = `${int(d.failed)} messages failed to deliver in the last hour`;
    return { id: c.id, name: c.name, kind: c.kind, status: c.status, conversations24h: byChannel.get(c.id) ?? 0, ...(problem ? { problem } : {}) };
  });
  const routers: FlowRouter[] = routersIn.map((r) => {
    const x = byRouter.get(r.id);
    const stuckSince = x?.stuck_since ? new Date(x.stuck_since).toISOString() : undefined;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      channelIds: channelsIn.filter((c) => c.router_id === r.id).map((c) => c.id),
      routed24h: int(x?.routed),
      stuck: int(x?.stuck),
      ...(stuckSince ? { stuckSince } : {}),
    };
  });
  const flowQueues: FlowQueue[] = queues.map((q) => {
    const oldest = q.oldest ? new Date(q.oldest).getTime() : null;
    return {
      id: q.id,
      name: q.name,
      routerIds: routersIn.filter((r) => (r.queue_ids ?? []).includes(q.id)).map((r) => r.id),
      agentId: q.agent_id,
      waiting: int(q.waiting),
      oldestWaitSeconds: oldest === null ? null : Math.max(0, Math.round((now.getTime() - oldest) / 1000)),
      slaAtRisk: int(q.at_risk),
    };
  });
  const agents: FlowAgent[] = agentRows.rows.map((a) => {
    const n = int(a.conversations);
    const contained = ratio(n - int(a.human_involved), n);
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      queueIds: queues.filter((q) => q.agent_id === a.id).map((q) => q.id),
      conversations24h: n,
      containment: num(contained),
      escalations24h: int(a.escalations),
    };
  });
  return { channels, routers, queues: flowQueues, agents };
}

/** The flow without internal fields (what the API returns). */
export function publicFlow(flow: HomeFlow): HomeFlow {
  return { ...flow, routers: flow.routers.map(({ stuckSince: _s, ...r }) => r) };
}
