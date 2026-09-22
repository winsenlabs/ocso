import { sql, type SQL } from 'drizzle-orm';
import { displayId } from '@ocso/domain';
import type { DbOrTx } from '@ocso/db';
import { agentClause, windowAgents, at, int, iso, num, type AnalyticsWindow } from './values.js';

export interface CorrectionOpportunity {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  observed: string;
  desired: string;
  componentKey: string;
  status: 'OPEN' | 'STAGED';
  source: string;
  occurrences: number;
  conversationId: string | null;
  createdAt: string;
}

export interface ReviewedConversation {
  reviewId: string;
  conversationId: string;
  displayId: string;
  customerName: string | null;
  channelKind: string | null;
  topic: string | null;
  reviewerName: string;
  outcomeTag: string;
  controlState: string;
  score: number;
  rubric: Record<string, number>;
  reviewedAt: string;
  openedAt: string;
}

/** OPEN/STAGED prompt corrections (definitions.corrections) via prompt_corrections_agent_idx; `scope` narrows agentId = null (ADR-026). */
export async function correctionOpportunities(
  db: DbOrTx,
  agentId: string | null,
  limit = 10,
  scope: SQL | null = null,
): Promise<{ open: number; staged: number; items: CorrectionOpportunity[] }> {
  const { rows } = await db.execute<{
    id: string; agent_id: string; agent_name: string; title: string; observed: string; desired: string; component_key: string;
    status: 'OPEN' | 'STAGED'; source: string; occurrences: number; conversation_id: string | null; created_at: Date; open_n: number; staged_n: number;
  }>(sql`
    SELECT p.id, p.agent_id, a.name AS agent_name, p.title, p.observed, p.desired, p.component_key, p.status, p.source,
           p.occurrences, p.conversation_id, p.created_at,
           (count(*) FILTER (WHERE p.status = 'OPEN') OVER ())::int AS open_n,
           (count(*) FILTER (WHERE p.status = 'STAGED') OVER ())::int AS staged_n
      FROM prompt_corrections p
      JOIN virtual_agents a ON a.id = p.agent_id
     WHERE ${agentClause(sql`p.agent_id`, agentId, scope)} AND p.status IN ('OPEN', 'STAGED')
     ORDER BY p.occurrences DESC, p.created_at DESC
     LIMIT ${limit}`);
  return {
    open: int(rows[0]?.open_n),
    staged: int(rows[0]?.staged_n),
    items: rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      agentName: r.agent_name,
      title: r.title,
      observed: r.observed,
      desired: r.desired,
      componentKey: r.component_key,
      status: r.status,
      source: r.source,
      occurrences: int(r.occurrences),
      conversationId: r.conversation_id,
      createdAt: iso(r.created_at)!,
    })),
  };
}

/** Latest reviews (rubric + mean score as stored) with conversation context for leads. */
export async function reviewedConversations(db: DbOrTx, w: AnalyticsWindow, limit = 10): Promise<{ inWindow: number; items: ReviewedConversation[] }> {
  const { rows } = await db.execute<{
    id: string; conversation_id: string; customer_name: string | null; channel_kind: string | null; topic: string | null; reviewer_name: string;
    outcome_tag: string; control_state: string; score: number; rubric: Record<string, number>; created_at: Date; opened_at: Date; in_window: number;
  }>(sql`
    SELECT r.id, r.conversation_id, cu.display_name AS customer_name, ch.kind AS channel_kind, i.topic, u.name AS reviewer_name,
           r.outcome_tag, c.control_state, r.score, r.rubric, r.created_at, c.opened_at,
           (count(*) OVER ())::int AS in_window
      FROM conversation_reviews r
      JOIN conversations c ON c.id = r.conversation_id
      JOIN customers cu ON cu.id = c.customer_id
      JOIN users u ON u.id = r.reviewer_id
      LEFT JOIN channels ch ON ch.id = c.channel_id
      LEFT JOIN conversation_insights i ON i.conversation_id = r.conversation_id
     WHERE ${windowAgents(sql`r.agent_id`, w)} AND r.created_at >= ${at(w.from)} AND r.created_at < ${at(w.to)}
     ORDER BY r.created_at DESC
     LIMIT ${limit}`);
  return {
    inWindow: int(rows[0]?.in_window),
    items: rows.map((r) => ({
      reviewId: r.id,
      conversationId: r.conversation_id,
      displayId: displayId('conv', r.conversation_id),
      customerName: r.customer_name,
      channelKind: r.channel_kind,
      topic: r.topic,
      reviewerName: r.reviewer_name,
      outcomeTag: r.outcome_tag,
      controlState: r.control_state,
      score: num(r.score) ?? 0,
      rubric: r.rubric,
      reviewedAt: iso(r.created_at)!,
      openedAt: iso(r.opened_at)!,
    })),
  };
}
