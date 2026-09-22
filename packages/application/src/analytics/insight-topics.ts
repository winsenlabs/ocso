import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { agentClause, at, cohortWhere, int, iso, labelKey, type AnalyticsWindow } from './values.js';

export interface LabelCount {
  key: string;
  label: string;
  count: number;
}

export interface KnowledgeGap extends LabelCount {
  firstSeenAt: string;
  isNew: boolean;
}

export interface InsightMix {
  /** Cohort conversations that have a conversation_insights row. */
  analyzed: number;
  outcomes: Record<string, number>;
  sentiments: Record<string, number>;
}

export interface SalesOutcomeRow {
  agentId: string;
  agentName: string;
  outcome: string;
  count: number;
}

const insightColumn = { failure: sql`i.failure_topic`, topic: sql`i.topic`, gap: sql`i.knowledge_gap` } as const;

/** Most frequent normalized classifier labels on cohort conversations (definitions.insightTopics). */
export async function topInsightLabels(db: DbOrTx, w: AnalyticsWindow, column: 'failure' | 'topic', limit = 10): Promise<LabelCount[]> {
  const col = insightColumn[column];
  const { rows } = await db.execute<{ key: string; label: string; n: number }>(sql`
    SELECT ${labelKey(col)} AS key, max(trim(${col})) AS label, count(*)::int AS n
      FROM conversations c
      JOIN conversation_insights i ON i.conversation_id = c.id
     WHERE ${cohortWhere(w)} AND ${col} IS NOT NULL AND trim(${col}) <> ''
     GROUP BY 1
     ORDER BY n DESC, key
     LIMIT ${limit}`);
  return rows.map((r) => ({ key: r.key, label: r.label, count: int(r.n) }));
}

/** Knowledge gaps with first-seen time (definitions.knowledgeGapNew); reads conversation_insights_agent_idx. */
export async function knowledgeGaps(db: DbOrTx, w: AnalyticsWindow, limit = 10): Promise<KnowledgeGap[]> {
  const col = insightColumn.gap;
  const { rows } = await db.execute<{ key: string; label: string; n: number; first_seen: Date }>(sql`
    WITH gaps AS (
      SELECT ${labelKey(col)} AS key, trim(${col}) AS label, i.generated_at, c.opened_at
        FROM conversation_insights i
        JOIN conversations c ON c.id = i.conversation_id
       WHERE ${agentClause(sql`i.agent_id`, w.agentId)} AND ${col} IS NOT NULL AND trim(${col}) <> '' AND c.opened_at < ${at(w.to)}
    )
    SELECT key, max(label) AS label,
           count(*) FILTER (WHERE opened_at >= ${at(w.from)})::int AS n,
           min(generated_at) AS first_seen
      FROM gaps
     GROUP BY key
    HAVING count(*) FILTER (WHERE opened_at >= ${at(w.from)}) > 0
     ORDER BY n DESC, key
     LIMIT ${limit}`);
  return rows.map((r) => {
    const firstSeenAt = iso(r.first_seen)!;
    return { key: r.key, label: r.label, count: int(r.n), firstSeenAt, isNew: new Date(firstSeenAt) >= w.from };
  });
}

/** Outcome and sentiment mix of analyzed cohort conversations. */
export async function insightMix(db: DbOrTx, w: AnalyticsWindow): Promise<InsightMix> {
  const group = async (col: SQL) => {
    const { rows } = await db.execute<{ k: string | null; n: number }>(sql`
      SELECT ${col} AS k, count(*)::int AS n
        FROM conversations c JOIN conversation_insights i ON i.conversation_id = c.id
       WHERE ${cohortWhere(w)}
       GROUP BY 1`);
    return rows;
  };
  const [outcomes, sentiments] = await Promise.all([group(sql`i.outcome`), group(sql`i.sentiment`)]);
  const toRecord = (rows: Array<{ k: string | null; n: number }>) => Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k!, int(r.n)]));
  return { analyzed: outcomes.reduce((s, r) => s + int(r.n), 0), outcomes: toRecord(outcomes), sentiments: toRecord(sentiments) };
}

/** conversation_insights.sales_outcome for SALES agents in scope, per agent, as UPPER_SNAKE codes (same normalization as the insights job). */
export async function salesOutcomes(db: DbOrTx, w: AnalyticsWindow): Promise<SalesOutcomeRow[]> {
  const { rows } = await db.execute<{ agent_id: string; agent_name: string; outcome: string; n: number }>(sql`
    SELECT c.agent_id, a.name AS agent_name, upper(regexp_replace(trim(i.sales_outcome), '[[:space:]]+', '_', 'g')) AS outcome, count(*)::int AS n
      FROM conversations c
      JOIN virtual_agents a ON a.id = c.agent_id AND a.conversation_type = 'SALES'
      JOIN conversation_insights i ON i.conversation_id = c.id
     WHERE ${cohortWhere(w)} AND i.sales_outcome IS NOT NULL AND trim(i.sales_outcome) <> ''
     GROUP BY c.agent_id, a.name, 3
     ORDER BY a.name, n DESC`);
  return rows.map((r) => ({ agentId: r.agent_id, agentName: r.agent_name, outcome: r.outcome, count: int(r.n) }));
}
