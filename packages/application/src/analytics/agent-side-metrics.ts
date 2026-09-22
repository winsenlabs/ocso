import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { windowAgents, at, cohortWhere, int, num, ratio, type AnalyticsWindow } from './values.js';

export interface CsatStat {
  average: number | null;
  responses: number;
  aiHandledAverage: number | null;
  humanHandledAverage: number | null;
}

export interface CostStat {
  costMicros: number | null;
  /** `MIXED` when priced events span currencies. */
  currency: string | null;
  cachedInputShare: number | null;
}

export interface ToolFailureStat {
  finished: number;
  failed: number;
  failureRate: number | null;
}

interface Grouped<T> {
  total: T;
  byAgent: Map<string, T>;
}

function split<R extends { agent_id: string | null; is_total: number }, T>(rows: R[], map: (r: R | null) => T): Grouped<T> {
  const byAgent = new Map<string, T>();
  let total = map(null);
  for (const r of rows) {
    if (int(r.is_total) === 1) total = map(r);
    else if (r.agent_id) byAgent.set(r.agent_id, map(r));
  }
  return { total, byAgent };
}

/** CSAT (definitions.csat) from csat_responses_agent_idx (agent_id, received_at). */
export async function csatStats(db: DbOrTx, w: AnalyticsWindow): Promise<Grouped<CsatStat>> {
  const { rows } = await db.execute<{ agent_id: string | null; is_total: number; avg: number | null; n: number; ai: number | null; human: number | null }>(sql`
    SELECT r.agent_id, grouping(r.agent_id) AS is_total,
           avg(r.score)::float8 AS avg, count(*)::int AS n,
           (avg(r.score) FILTER (WHERE NOT r.handled_by_human))::float8 AS ai,
           (avg(r.score) FILTER (WHERE r.handled_by_human))::float8 AS human
      FROM csat_responses r
     WHERE ${windowAgents(sql`r.agent_id`, w)} AND r.received_at >= ${at(w.from)} AND r.received_at < ${at(w.to)}
     GROUP BY GROUPING SETS ((r.agent_id), ())`);
  return split(rows, (r) => ({ average: num(r?.avg), responses: int(r?.n), aiHandledAverage: num(r?.ai), humanHandledAverage: num(r?.human) }));
}

/** Model cost in the window (definitions.costPerConversation numerator) from usage_events_agent_idx. */
export async function costStats(db: DbOrTx, w: AnalyticsWindow): Promise<Grouped<CostStat>> {
  const { rows } = await db.execute<{ agent_id: string | null; is_total: number; cost: number | null; currencies: string[] | null; cached: number | null; reported_input: number | null }>(sql`
    SELECT u.agent_id, grouping(u.agent_id) AS is_total,
           sum(u.cost_micros)::float8 AS cost,
           array_agg(DISTINCT u.currency) FILTER (WHERE u.currency IS NOT NULL) AS currencies,
           sum(u.cached_input_tokens)::float8 AS cached,
           (sum(u.input_tokens) FILTER (WHERE u.cached_input_tokens IS NOT NULL))::float8 AS reported_input
      FROM usage_events u
     WHERE ${windowAgents(sql`u.agent_id`, w)} AND u.occurred_at >= ${at(w.from)} AND u.occurred_at < ${at(w.to)}
     GROUP BY GROUPING SETS ((u.agent_id), ())`);
  return split(rows, (r) => {
    const currencies = r?.currencies ?? [];
    const cached = num(r?.cached);
    const reported = num(r?.reported_input);
    return {
      costMicros: num(r?.cost),
      currency: currencies.length === 0 ? null : currencies.length === 1 ? currencies[0]! : 'MIXED',
      cachedInputShare: cached !== null && reported ? cached / reported : null,
    };
  });
}

/** Tool failure rate (definitions.toolFailure): cohort → tool_calls_conversation_idx. */
export async function toolFailureStats(db: DbOrTx, w: AnalyticsWindow): Promise<Grouped<ToolFailureStat>> {
  const { rows } = await db.execute<{ agent_id: string | null; is_total: number; finished: number; failed: number }>(sql`
    SELECT c.agent_id, grouping(c.agent_id) AS is_total,
           count(tc.id)::int AS finished,
           count(tc.id) FILTER (WHERE tc.status = 'FAILED')::int AS failed
      FROM conversations c
      JOIN tool_calls tc ON tc.conversation_id = c.id AND tc.actor_type = 'AGENT' AND tc.status IN ('SUCCEEDED', 'FAILED')
     WHERE ${cohortWhere(w)}
     GROUP BY GROUPING SETS ((c.agent_id), ())`);
  return split(rows, (r) => ({ finished: int(r?.finished), failed: int(r?.failed), failureRate: ratio(int(r?.failed), int(r?.finished)) }));
}
