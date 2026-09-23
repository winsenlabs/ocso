import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, cohortWhere, int, num, ratio, type AnalyticsWindow } from './values.js';

/** Raw cohort counts for one agent (or the whole scope when agentId is null). */
export interface ConversationKpis {
  agentId: string | null;
  conversations: number;
  contained: number;
  escalated: number;
  resolved: number;
  slaBreaches: number;
  reopened: number;
  resolvedEver: number;
  firstResponseAiMedianSeconds: number | null;
  timeToResolutionMedianSeconds: number | null;
  containmentRate: number | null;
  escalationRate: number | null;
  resolutionRate: number | null;
  reopenRate: number | null;
}

type Row = {
  agent_id: string | null;
  is_total: number;
  conversations: number;
  contained: number;
  escalated: number;
  resolved: number;
  sla_breaches: number;
  reopened: number;
  resolved_ever: number;
  first_response: number | null;
  ttr: number | null;
};

/**
 * Cohort KPIs per agent plus the scope total in one pass (GROUPING SETS).
 * Formulas: analytics/definitions.ts (containment, escalation, resolution,
 * slaBreaches, reopen, firstResponseAi, timeToResolution). The cohort is read
 * through conversations_agent_idx; handoffs/interactions by conversation id.
 */
export async function conversationKpis(db: DbOrTx, w: AnalyticsWindow, now: Date): Promise<{ total: ConversationKpis; byAgent: Map<string, ConversationKpis> }> {
  const { rows } = await db.execute<Row>(sql`
    WITH cohort AS (
      SELECT c.id, c.agent_id, c.control_state, c.opened_at, c.resolved_at, c.reopen_count, c.sla_due_at, c.first_human_response_at,
             EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id) AS human_involved,
             EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST') AS escalated
        FROM conversations c
       WHERE ${cohortWhere(w)}
    ),
    first_reply AS (
      SELECT k.id, extract(epoch FROM fa.created_at - fc.created_at)::float8 AS seconds
        FROM cohort k
        CROSS JOIN LATERAL (
          SELECT i.seq, i.created_at FROM interactions i
           WHERE i.conversation_id = k.id AND i.actor_type = 'CUSTOMER' AND i.kind = 'MESSAGE'
           ORDER BY i.seq LIMIT 1) fc
        CROSS JOIN LATERAL (
          SELECT i.created_at FROM interactions i
           WHERE i.conversation_id = k.id AND i.actor_type = 'AGENT' AND i.kind = 'MESSAGE' AND i.seq > fc.seq
           ORDER BY i.seq LIMIT 1) fa
    )
    SELECT k.agent_id, grouping(k.agent_id) AS is_total,
           count(*)::int AS conversations,
           count(*) FILTER (WHERE NOT k.human_involved)::int AS contained,
           count(*) FILTER (WHERE k.escalated)::int AS escalated,
           count(*) FILTER (WHERE k.control_state = 'RESOLVED')::int AS resolved,
           count(*) FILTER (WHERE (k.control_state IN ('ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN') AND k.sla_due_at < ${at(now)})
                               OR k.first_human_response_at > k.sla_due_at)::int AS sla_breaches,
           count(*) FILTER (WHERE k.reopen_count > 0)::int AS reopened,
           count(*) FILTER (WHERE k.control_state = 'RESOLVED' OR k.reopen_count > 0)::int AS resolved_ever,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY fr.seconds) AS first_response,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM k.resolved_at - k.opened_at))
             FILTER (WHERE k.control_state = 'RESOLVED' AND k.resolved_at IS NOT NULL) AS ttr
      FROM cohort k
      LEFT JOIN first_reply fr ON fr.id = k.id
     GROUP BY GROUPING SETS ((k.agent_id), ())`);
  const byAgent = new Map<string, ConversationKpis>();
  let total = toKpis(null, null);
  for (const r of rows) {
    if (int(r.is_total) === 1) total = toKpis(null, r);
    else if (r.agent_id) byAgent.set(r.agent_id, toKpis(r.agent_id, r));
  }
  if (w.agentId) total = { ...total, agentId: w.agentId };
  return { total, byAgent };
}

/** KPIs for an agent without cohort conversations. */
export const emptyKpis = (agentId: string | null): ConversationKpis => toKpis(agentId, null);

function toKpis(agentId: string | null, r: Row | null): ConversationKpis {
  const conversations = int(r?.conversations);
  const contained = int(r?.contained);
  const escalated = int(r?.escalated);
  const resolved = int(r?.resolved);
  const reopened = int(r?.reopened);
  const resolvedEver = int(r?.resolved_ever);
  const fr = num(r?.first_response);
  const ttr = num(r?.ttr);
  return {
    agentId,
    conversations,
    contained,
    escalated,
    resolved,
    slaBreaches: int(r?.sla_breaches),
    reopened,
    resolvedEver,
    firstResponseAiMedianSeconds: fr === null ? null : Math.round(fr * 10) / 10,
    timeToResolutionMedianSeconds: ttr === null ? null : Math.round(ttr),
    containmentRate: ratio(contained, conversations),
    escalationRate: ratio(escalated, conversations),
    resolutionRate: ratio(resolved, conversations),
    reopenRate: ratio(reopened, resolvedEver),
  };
}
