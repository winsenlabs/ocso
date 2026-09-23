import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';

/**
 * Which channels reach which agents (PM/research/11 §5): derived through each
 * channel's ACTIVE router — every queue its active version can route to (the
 * rules and the fallback) — and each queue's agent. Replaces the deprecated
 * `channels.default_agent_id` / `agent_channels` records.
 */
export const CHANNEL_AGENT_REACH: SQL = sql`
  SELECT DISTINCT ch.id AS channel_id, q.agent_id AS agent_id, q.id AS queue_id, r.id AS router_id
    FROM channels ch
    JOIN routers r ON r.id = ch.router_id AND r.status = 'ACTIVE'
    JOIN router_versions v ON v.id = r.active_version_id
    JOIN queues q ON q.agent_id IS NOT NULL AND q.id::text IN (
      SELECT v.definition ->> 'fallbackQueueId'
      UNION ALL
      SELECT rule ->> 'queueId' FROM jsonb_array_elements(COALESCE(v.definition -> 'rules', '[]'::jsonb)) AS rule
    )`;

/** Subquery: ids of channels that reach an agent in the given subquery of agent ids. */
export function channelsReachingAgents(agentIds: SQL): SQL {
  return sql`SELECT reach.channel_id FROM (${CHANNEL_AGENT_REACH}) AS reach WHERE reach.agent_id IN (${agentIds})`;
}

export interface ChannelReach {
  channelId: string;
  agentId: string;
  queueId: string;
  routerId: string;
}

/** Channel → agent pairs for these agents (the agent's "Reached through" list). */
export async function reachForAgents(db: DbOrTx, agentIds: readonly string[]): Promise<ChannelReach[]> {
  if (!agentIds.length) return [];
  const rows = await db.execute<{ channel_id: string; agent_id: string; queue_id: string; router_id: string }>(
    sql`SELECT * FROM (${CHANNEL_AGENT_REACH}) AS reach WHERE reach.agent_id IN (${sql.join(
      agentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  return rows.rows.map((r) => ({ channelId: r.channel_id, agentId: r.agent_id, queueId: r.queue_id, routerId: r.router_id }));
}

/** The agent a pass-through router answers as (its fallback queue's agent); null for step routers or no router. */
export async function passThroughAgentOf(db: DbOrTx, channelIds: readonly string[]): Promise<Map<string, string>> {
  if (!channelIds.length) return new Map();
  const rows = await db.execute<{ channel_id: string; agent_id: string }>(sql`
    SELECT ch.id AS channel_id, q.agent_id
      FROM channels ch
      JOIN routers r ON r.id = ch.router_id AND r.status = 'ACTIVE'
      JOIN router_versions v ON v.id = r.active_version_id
      JOIN queues q ON q.id::text = v.definition ->> 'fallbackQueueId'
     WHERE jsonb_array_length(COALESCE(v.definition -> 'steps', '[]'::jsonb)) = 0
       AND q.agent_id IS NOT NULL
       AND ch.id IN (${sql.join(
         channelIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`);
  return new Map(rows.rows.map((r) => [r.channel_id, r.agent_id]));
}
