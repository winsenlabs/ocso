import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { agentClause, at, int, iso, ratio } from './values.js';

export interface DailyPoint {
  /** Calendar day (YYYY-MM-DD) in the deployment timezone. */
  day: string;
  conversations: number;
  contained: number;
  escalated: number;
  containmentRate: number | null;
  escalationRate: number | null;
}

export interface PromptVersionMarker {
  agentId: string;
  agentName: string;
  versionId: string;
  version: number;
  reason: string;
  activatedAt: string;
  actorName: string | null;
}

/**
 * Containment/escalation per calendar day over the last `days` days (docs/11
 * §3, design/02 chart). Same formulas as the tiles (definitions.containment /
 * escalation), with the cohort being conversations opened on that day.
 */
export async function containmentSeries(db: DbOrTx, agentId: string | null, days: number, now: Date, timezone: string, scope: SQL | null = null): Promise<DailyPoint[]> {
  const { rows } = await db.execute<{ day: string; conversations: number; contained: number; escalated: number }>(sql`
    WITH days AS (
      SELECT generate_series(
               date_trunc('day', ${at(now)} AT TIME ZONE ${timezone}) - make_interval(days => ${days - 1}),
               date_trunc('day', ${at(now)} AT TIME ZONE ${timezone}),
               interval '1 day') AS d
    )
    SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
           count(c.id)::int AS conversations,
           count(c.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id))::int AS contained,
           count(c.id) FILTER (WHERE EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'))::int AS escalated
      FROM days
      LEFT JOIN conversations c
        ON ${agentClause(sql`c.agent_id`, agentId, scope)}
       AND c.opened_at >= (days.d AT TIME ZONE ${timezone})
       AND c.opened_at < ((days.d + interval '1 day') AT TIME ZONE ${timezone})
       AND c.opened_at <= ${at(now)}
     GROUP BY days.d
     ORDER BY days.d`);
  return rows.map((r) => ({
    day: r.day,
    conversations: int(r.conversations),
    contained: int(r.contained),
    escalated: int(r.escalated),
    containmentRate: ratio(int(r.contained), int(r.conversations)),
    escalationRate: ratio(int(r.escalated), int(r.conversations)),
  }));
}

/**
 * Prompt activations (including rollbacks) inside [from, to] from the audit log
 * (`prompt.activate`), joined to the activated version — chart markers.
 */
export async function promptVersionMarkers(db: DbOrTx, agentId: string | null, from: Date, to: Date, scope: SQL | null = null): Promise<PromptVersionMarker[]> {
  const target = agentId ? sql`AND e.target_id = ${agentId}` : scope ? sql`AND pv.agent_id IN (${scope})` : sql``;
  const { rows } = await db.execute<{ agent_id: string; agent_name: string; version_id: string; version: number; reason: string; occurred_at: Date; actor_name: string | null }>(sql`
    SELECT pv.agent_id, a.name AS agent_name, pv.id AS version_id, pv.version, pv.reason, e.occurred_at, e.actor_name
      FROM audit_events e
      JOIN prompt_versions pv ON pv.id = (e.after ->> 'activePromptVersionId')::uuid
      JOIN virtual_agents a ON a.id = pv.agent_id
     WHERE e.target_type = 'agent' AND e.action = 'prompt.activate' ${target}
       AND e.occurred_at >= ${at(from)} AND e.occurred_at <= ${at(to)}
     ORDER BY e.occurred_at`);
  return rows.map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    versionId: r.version_id,
    version: int(r.version),
    reason: r.reason,
    activatedAt: iso(r.occurred_at)!,
    actorName: r.actor_name,
  }));
}
