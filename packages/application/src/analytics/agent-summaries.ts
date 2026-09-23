import { sql } from 'drizzle-orm';
import type { Db } from '@ocso/db';

export interface AgentSummary {
  agentId: string;
  conversations: number;
  containmentRate: number | null;
  escalationRate: number | null;
  csat: number | null;
  csatResponses: number;
  openConversations: number;
  waitingForHuman: number;
}

/**
 * Explicit, auditable agent KPIs (docs/11 §3), same formulas as the analytics
 * read model (analytics/definitions.ts):
 * - containment = conversations opened in the window with no handoff of any trigger / all opened
 * - escalation  = conversations with ≥1 handoff whose trigger is not HUMAN_REQUEST / all opened
 * - csat        = mean of customer ratings received in the window
 */
export async function agentSummaries(db: Db, windowDays = 7): Promise<Map<string, AgentSummary>> {
  const { rows } = await db.execute<{
    agent_id: string;
    conversations: number;
    escalated: number;
    human_involved: number;
    open: number;
    waiting: number;
    csat: number | null;
    csat_n: number;
  }>(sql`
    WITH window_convs AS (
      SELECT c.id, c.agent_id, c.control_state,
             EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST') AS escalated,
             EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id) AS human_involved
        FROM conversations c
       WHERE c.opened_at > now() - make_interval(days => ${windowDays})
    ),
    csat AS (
      SELECT agent_id, avg(score)::float8 AS csat, count(*)::int AS csat_n
        FROM csat_responses WHERE received_at > now() - make_interval(days => ${windowDays})
       GROUP BY agent_id
    ),
    live AS (
      SELECT agent_id,
             count(*) FILTER (WHERE control_state <> 'RESOLVED')::int AS open,
             count(*) FILTER (WHERE control_state IN ('WAITING_FOR_HUMAN', 'ESCALATION_REQUESTED'))::int AS waiting
        FROM conversations GROUP BY agent_id
    )
    SELECT a.id AS agent_id,
           count(w.id)::int AS conversations,
           count(w.id) FILTER (WHERE w.escalated)::int AS escalated,
           count(w.id) FILTER (WHERE w.human_involved)::int AS human_involved,
           coalesce(l.open, 0) AS open,
           coalesce(l.waiting, 0) AS waiting,
           cs.csat, coalesce(cs.csat_n, 0) AS csat_n
      FROM virtual_agents a
      LEFT JOIN window_convs w ON w.agent_id = a.id
      LEFT JOIN live l ON l.agent_id = a.id
      LEFT JOIN csat cs ON cs.agent_id = a.id
     GROUP BY a.id, l.open, l.waiting, cs.csat, cs.csat_n`);
  return new Map(
    rows.map((r) => [
      r.agent_id,
      {
        agentId: r.agent_id,
        conversations: r.conversations,
        containmentRate: r.conversations ? (r.conversations - r.human_involved) / r.conversations : null,
        escalationRate: r.conversations ? r.escalated / r.conversations : null,
        csat: r.csat,
        csatResponses: r.csat_n,
        openConversations: r.open,
        waitingForHuman: r.waiting,
      },
    ]),
  );
}
