import { sql, type SQL } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { displayId } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { maskIdentity } from '../conversations/masking.js';
import { DEFINITIONS } from './definitions.js';
import { at, int, iso, num } from './values.js';

export interface PickupItem {
  conversationId: string;
  displayId: string;
  customerName: string | null;
  identity: string | null;
  channelKind: string | null;
  agentName: string;
  queueName: string | null;
  priority: string;
  reason: string | null;
  trigger: string | null;
  waitingSince: string | null;
  slaDueAt: string | null;
  offeredToUserId: string | null;
}

export interface AssignedItem {
  conversationId: string;
  displayId: string;
  customerName: string | null;
  agentName: string;
  controlState: string;
  priority: string;
  lastPreview: string | null;
  lastInteractionAt: string;
  slaDueAt: string | null;
}

export interface ExecHome {
  tiles: {
    assignedToMe: number;
    waitingForHuman: number;
    slaBreached: number;
    resolvedToday: number;
    myFirstResponseMedianSeconds: number | null;
    myCsat7d: { average: number | null; responses: number };
  };
  pickupQueue: PickupItem[];
  assigned: AssignedItem[];
  shift: {
    availability: string;
    maxConcurrent: number;
    activeConversations: number;
    queues: Array<{ id: string; name: string }>;
    languages: string[];
    skills: string[];
  };
  forYou: Array<
    | { kind: 'offer'; conversationId: string; customerName: string | null; priority: string; waitingSince: string | null }
    | { kind: 'urgent_pickup'; conversationId: string; customerName: string | null; priority: string; waitingSince: string | null; reason: string | null }
    | { kind: 'alert'; alertId: string; title: string; severity: string; openedAt: string }
  >;
  recentlyResolved: Array<{ conversationId: string; displayId: string; customerName: string | null; disposition: string | null; topic: string | null; csat: number | null; resolvedAt: string }>;
  definitions: Record<string, string>;
}

const OPEN = sql`('AI_ACTIVE', 'ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'AI_RESUMING')`;
const uuidList = (ids: readonly string[]): SQL => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

/** Conversation list rows with the customer/agent/channel context an exec needs. */
async function conversationRows(db: Db, where: SQL, order: SQL, limit: number) {
  const { rows } = await db.execute<{
    id: string; priority: string; control_state: string; waiting_since: Date | null; sla_due_at: Date | null; assigned_user_id: string | null;
    last_preview: string | null; last_interaction_at: Date; customer_name: string | null; identity: string | null; channel_kind: string | null;
    agent_name: string; queue_name: string | null; reason_text: string | null; trigger: string | null;
  }>(sql`
    SELECT c.id, c.priority, c.control_state, c.waiting_since, c.sla_due_at, c.assigned_user_id, c.last_preview, c.last_interaction_at,
           cu.display_name AS customer_name, ch.kind AS channel_kind, a.name AS agent_name, q.name AS queue_name, h.reason_text, h.trigger,
           (SELECT ci.kind || ':' || ci.value FROM customer_identities ci WHERE ci.customer_id = c.customer_id ORDER BY ci.last_seen_at DESC LIMIT 1) AS identity
      FROM conversations c
      JOIN customers cu ON cu.id = c.customer_id
      JOIN virtual_agents a ON a.id = c.agent_id
      LEFT JOIN channels ch ON ch.id = c.channel_id
      LEFT JOIN queues q ON q.id = c.queue_id
      LEFT JOIN LATERAL (
        SELECT reason_text, trigger FROM handoffs
         WHERE conversation_id = c.id AND resolved_at IS NULL AND cancelled_at IS NULL AND returned_at IS NULL
         ORDER BY requested_at DESC LIMIT 1) h ON true
     WHERE ${where}
     ORDER BY ${order}
     LIMIT ${limit}`);
  return rows;
}

/**
 * Service member home (design/06 exec): assigned work, the pickup queue of the exec's
 * team queues, SLA risk, personal throughput and satisfaction. Only
 * conversations the exec may see (assigned, or waiting in their team queues).
 */
export async function execHome(db: Db, principal: Principal, queueIds: readonly string[], now: Date, dayStart: Date): Promise<ExecHome> {
  const me = principal.userId;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const inMyQueues = queueIds.length ? sql`c.queue_id = ANY(${uuidList(queueIds)})` : sql`false`;
  const [counts, firstResponse, csat, pickup, assigned, user, queues, alerts, resolved] = await Promise.all([
    db.execute<{ assigned: number; waiting: number; breached: number; resolved_today: number }>(sql`
      SELECT count(*) FILTER (WHERE c.assigned_user_id = ${me}::uuid AND c.control_state IN ${OPEN})::int AS assigned,
             count(*) FILTER (WHERE c.control_state = 'WAITING_FOR_HUMAN' AND ${inMyQueues})::int AS waiting,
             count(*) FILTER (WHERE c.control_state IN ('ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN') AND c.sla_due_at < ${at(now)}
                               AND (${inMyQueues} OR c.assigned_user_id = ${me}::uuid))::int AS breached,
             (SELECT count(DISTINCT e.target_id)::int FROM audit_events e
               WHERE e.actor_id = ${me} AND e.action = 'conversation.resolve' AND e.occurred_at >= ${at(dayStart)} AND e.occurred_at <= ${at(now)}) AS resolved_today
        FROM conversations c
       WHERE c.control_state IN ${OPEN} AND (c.assigned_user_id = ${me}::uuid OR ${inMyQueues})`),
    db.execute<{ median: number | null }>(sql`
      WITH pickups AS MATERIALIZED (
        SELECT e.target_id, e.occurred_at FROM audit_events e
         WHERE e.actor_id = ${me} AND e.action IN ('conversation.claim', 'conversation.accept_assignment', 'conversation.take_over')
           AND e.occurred_at >= ${at(weekAgo)} AND e.occurred_at <= ${at(now)}
      )
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.created_at - p.occurred_at)) AS median
        FROM pickups p
        CROSS JOIN LATERAL (
          SELECT i.created_at FROM interactions i
           WHERE i.conversation_id = p.target_id::uuid AND i.actor_type = 'HUMAN' AND i.actor_id = ${me} AND i.kind = 'MESSAGE'
             AND i.visibility = 'CUSTOMER' AND i.created_at >= p.occurred_at
           ORDER BY i.seq LIMIT 1) r`),
    db.execute<{ avg: number | null; n: number }>(sql`
      SELECT avg(r.score)::float8 AS avg, count(*)::int AS n FROM csat_responses r
       WHERE r.agent_id IN (SELECT id FROM virtual_agents) AND r.received_at >= ${at(weekAgo)} AND r.received_at <= ${at(now)}
         AND EXISTS (SELECT 1 FROM interactions i WHERE i.conversation_id = r.conversation_id AND i.actor_type = 'HUMAN' AND i.actor_id = ${me} AND i.kind = 'MESSAGE')`),
    queueIds.length ? conversationRows(db, sql`c.control_state = 'WAITING_FOR_HUMAN' AND ${inMyQueues}`, sql`c.priority, c.waiting_since NULLS LAST`, 20) : Promise.resolve([]),
    conversationRows(db, sql`c.assigned_user_id = ${me}::uuid AND c.control_state IN ${OPEN}`, sql`c.last_interaction_at DESC`, 20),
    db.execute<{ availability: string; max_concurrent: number; languages: string[]; skills: string[]; active: number }>(sql`
      SELECT u.availability, u.max_concurrent, u.languages, u.skills,
             (SELECT count(*)::int FROM conversations c WHERE c.assigned_user_id = u.id AND c.control_state IN ('HUMAN_ACTIVE', 'WAITING_FOR_HUMAN', 'AI_RESUMING')) AS active
        FROM users u WHERE u.id = ${me}::uuid`),
    queueIds.length ? db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM queues WHERE id = ANY(${uuidList(queueIds)}) ORDER BY name`) : Promise.resolve({ rows: [] }),
    db.execute<{ id: string; title: string; severity: string; opened_at: Date }>(sql`
      SELECT id, title, severity, opened_at FROM alerts
       WHERE status IN ('OPEN', 'ACKNOWLEDGED') AND kind = 'BUSINESS' AND 'SERVICE' = ANY(audience_roles)
       ORDER BY opened_at DESC LIMIT 5`),
    db.execute<{ id: string; resolved_at: Date; disposition: string | null; csat_score: number | null; customer_name: string | null; topic: string | null }>(sql`
      WITH mine AS MATERIALIZED (
        SELECT e.target_id, max(e.occurred_at) AS resolved_at FROM audit_events e
         WHERE e.actor_id = ${me} AND e.action = 'conversation.resolve' AND e.occurred_at >= ${at(weekAgo)} AND e.occurred_at <= ${at(now)}
         GROUP BY e.target_id
      )
      SELECT c.id, m.resolved_at, c.disposition, c.csat_score, cu.display_name AS customer_name, i.topic
        FROM mine m
        JOIN conversations c ON c.id = m.target_id::uuid
        JOIN customers cu ON cu.id = c.customer_id
        LEFT JOIN conversation_insights i ON i.conversation_id = c.id
       ORDER BY m.resolved_at DESC LIMIT 5`),
  ]);
  const toPickup = (r: (typeof pickup)[number]): PickupItem => ({
    conversationId: r.id,
    displayId: displayId('conv', r.id),
    customerName: r.customer_name,
    identity: maskIdentity(r.identity),
    channelKind: r.channel_kind,
    agentName: r.agent_name,
    queueName: r.queue_name,
    priority: r.priority,
    reason: r.reason_text,
    trigger: r.trigger,
    waitingSince: iso(r.waiting_since),
    slaDueAt: iso(r.sla_due_at),
    offeredToUserId: r.assigned_user_id,
  });
  const c = counts.rows[0];
  const u = user.rows[0];
  const median = num(firstResponse.rows[0]?.median);
  return {
    tiles: {
      assignedToMe: int(c?.assigned),
      waitingForHuman: int(c?.waiting),
      slaBreached: int(c?.breached),
      resolvedToday: int(c?.resolved_today),
      myFirstResponseMedianSeconds: median === null ? null : Math.round(median),
      myCsat7d: { average: num(csat.rows[0]?.avg), responses: int(csat.rows[0]?.n) },
    },
    pickupQueue: pickup.map(toPickup),
    assigned: assigned.map((r) => ({
      conversationId: r.id,
      displayId: displayId('conv', r.id),
      customerName: r.customer_name,
      agentName: r.agent_name,
      controlState: r.control_state,
      priority: r.priority,
      lastPreview: r.last_preview,
      lastInteractionAt: iso(r.last_interaction_at)!,
      slaDueAt: iso(r.sla_due_at),
    })),
    shift: {
      availability: u?.availability ?? 'OFFLINE',
      maxConcurrent: int(u?.max_concurrent),
      activeConversations: int(u?.active),
      queues: queues.rows,
      languages: u?.languages ?? [],
      skills: u?.skills ?? [],
    },
    forYou: [
      ...assigned.filter((r) => r.control_state === 'WAITING_FOR_HUMAN').map((r) => ({ kind: 'offer' as const, conversationId: r.id, customerName: r.customer_name, priority: r.priority, waitingSince: iso(r.waiting_since) })),
      ...pickup
        .filter((r) => r.priority === 'P1' && !r.assigned_user_id)
        .slice(0, 3)
        .map((r) => ({ kind: 'urgent_pickup' as const, conversationId: r.id, customerName: r.customer_name, priority: r.priority, waitingSince: iso(r.waiting_since), reason: r.reason_text })),
      ...alerts.rows.map((a) => ({ kind: 'alert' as const, alertId: a.id, title: a.title, severity: a.severity, openedAt: iso(a.opened_at)! })),
    ],
    recentlyResolved: resolved.rows.map((r) => ({
      conversationId: r.id,
      displayId: displayId('conv', r.id),
      customerName: r.customer_name,
      disposition: r.disposition,
      topic: r.topic,
      csat: num(r.csat_score),
      resolvedAt: iso(r.resolved_at)!,
    })),
    definitions: {
      myFirstResponseMedianSeconds: DEFINITIONS.myFirstResponse,
      myCsat7d: DEFINITIONS.myCsat,
      resolvedToday: DEFINITIONS.resolvedToday,
      slaBreached: 'Conversations waiting for a human in my team queues or assigned to me whose sla_due_at has passed.',
      waitingForHuman: 'WAITING_FOR_HUMAN conversations in queues served by my teams.',
    },
  };
}
