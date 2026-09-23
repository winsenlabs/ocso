import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, ratio, rounded } from '../analytics/values.js';
import type { QueueDepth } from './queue-depth.js';
import type { TokenUsage } from './token-usage.js';
import type { WorkerFleet } from './workers.js';

export interface ModelWindowStats {
  requests: number;
  errors: number;
  errorRate: number | null;
  requestsPerMinute: number;
  ttftP95Ms: number | null;
  latencyP95Ms: number | null;
  fallbacks: number;
}

export interface WorstTool {
  toolName: string;
  connectionName: string | null;
  finished: number;
  failed: number;
  failureRate: number;
}

export interface TelemetryTiles {
  windowMinutes: number;
  activeConversations: number;
  healthyWorkers: { healthy: number; max: number; minWarm: number };
  queue: { depth: number; oldestAgeSeconds: number | null; turnDepth: number; turnOldestAgeSeconds: number | null };
  turnLatencyP95Ms: number | null;
  ttftP95Ms: number | null;
  requestsPerMinute: number;
  tokensToday: number;
  cachedInputShareToday: number | null;
  providerErrorRate: number | null;
  worstToolFailure: WorstTool | null;
  definitions: Record<string, string>;
}

export const OPEN_STATES_SQL = sql`('AI_ACTIVE', 'ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'AI_RESUMING')`;
export const WORST_TOOL_MIN_CALLS = 5;

/** Model request attempts in [from, to): error rate, p95 TTFT (TURN, OK), p95 latency, fallbacks (usage_events_time_idx). */
export async function modelWindowStats(db: DbOrTx, from: Date, to: Date): Promise<ModelWindowStats> {
  const { rows } = await db.execute<{ requests: number; errors: number; ttft: number | null; latency: number | null; fallbacks: number }>(sql`
    SELECT count(*)::int AS requests,
           count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE purpose = 'TURN' AND status = 'OK') AS ttft,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'OK') AS latency,
           count(*) FILTER (WHERE fallback_from_provider_id IS NOT NULL)::int AS fallbacks
      FROM usage_events
     WHERE occurred_at >= ${at(from)} AND occurred_at < ${at(to)}`);
  const r = rows[0];
  const requests = int(r?.requests);
  const errors = int(r?.errors);
  const minutes = Math.max(1, (to.getTime() - from.getTime()) / 60_000);
  return {
    requests,
    errors,
    errorRate: ratio(errors, requests),
    requestsPerMinute: Math.round((requests / minutes) * 10) / 10,
    ttftP95Ms: rounded(r?.ttft),
    latencyP95Ms: rounded(r?.latency),
    fallbacks: int(r?.fallbacks),
  };
}

/** p95 end-to-end turn latency of turns completed in [from, to) (turns_status_idx). */
export async function turnLatencyP95(db: DbOrTx, from: Date, to: Date): Promise<number | null> {
  const { rows } = await db.execute<{ p95: number | null }>(sql`
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM turns WHERE status = 'COMPLETED' AND started_at >= ${at(from)} AND started_at < ${at(to)}`);
  return rounded(rows[0]?.p95);
}

/** Open conversations (control state not RESOLVED) — a count only, no content. */
export async function activeConversations(db: DbOrTx): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations WHERE control_state IN ${OPEN_STATES_SQL}`);
  return int(rows[0]?.n);
}

/** Tool with the highest failure rate over finished calls in [from, to) with at least WORST_TOOL_MIN_CALLS calls (tool_calls_status_idx). */
export async function worstToolFailure(db: DbOrTx, from: Date, to: Date): Promise<WorstTool | null> {
  const { rows } = await db.execute<{ tool_name: string; connection_name: string | null; finished: number; failed: number }>(sql`
    SELECT tc.tool_name, max(mc.name) AS connection_name, count(*)::int AS finished, count(*) FILTER (WHERE tc.status = 'FAILED')::int AS failed
      FROM tool_calls tc
      LEFT JOIN mcp_connections mc ON mc.id = tc.connection_id
     WHERE tc.status IN ('SUCCEEDED', 'FAILED') AND tc.requested_at >= ${at(from)} AND tc.requested_at < ${at(to)}
     GROUP BY tc.tool_name
    HAVING count(*) >= ${WORST_TOOL_MIN_CALLS} AND count(*) FILTER (WHERE tc.status = 'FAILED') > 0
     ORDER BY count(*) FILTER (WHERE tc.status = 'FAILED')::float8 / count(*) DESC, failed DESC
     LIMIT 1`);
  const r = rows[0];
  if (!r) return null;
  return { toolName: r.tool_name, connectionName: r.connection_name, finished: int(r.finished), failed: int(r.failed), failureRate: int(r.failed) / int(r.finished) };
}

/** Tech admin tiles (design/03 tile row), windowed to the last `windowMinutes` except "today" figures. */
export async function telemetryTiles(
  db: DbOrTx,
  now: Date,
  windowMinutes: number,
  deps: { fleet: WorkerFleet; queue: QueueDepth; today: TokenUsage },
): Promise<TelemetryTiles> {
  const from = new Date(now.getTime() - windowMinutes * 60_000);
  const [active, turnP95, model, worst] = await Promise.all([
    activeConversations(db),
    turnLatencyP95(db, from, now),
    modelWindowStats(db, from, now),
    worstToolFailure(db, new Date(now.getTime() - 86_400_000), now),
  ]);
  const t = deps.today.totals;
  return {
    windowMinutes,
    activeConversations: active,
    healthyWorkers: { healthy: deps.fleet.healthy, max: deps.fleet.settings.maxWorkers, minWarm: deps.fleet.settings.minWarmWorkers },
    queue: { depth: deps.queue.depth, oldestAgeSeconds: deps.queue.oldestAgeSeconds, turnDepth: deps.queue.turn.depth, turnOldestAgeSeconds: deps.queue.turn.oldestAgeSeconds },
    turnLatencyP95Ms: turnP95,
    ttftP95Ms: model.ttftP95Ms,
    requestsPerMinute: model.requestsPerMinute,
    tokensToday: t.inputTokens + t.outputTokens,
    cachedInputShareToday: t.cachedInputShare,
    providerErrorRate: model.errorRate,
    worstToolFailure: worst,
    definitions: {
      activeConversations: 'Conversations whose control state is not RESOLVED.',
      turnLatencyP95Ms: 'p95 of turns.latency_ms for COMPLETED turns started in the window.',
      ttftP95Ms: 'p95 of usage_events.ttft_ms for successful TURN model requests in the window.',
      requestsPerMinute: 'Model request attempts (usage_events rows, including retries and fallbacks) in the window / window minutes.',
      tokensToday: 'Input + output tokens of usage_events since the start of today (deployment timezone).',
      providerErrorRate: 'usage_events with status ERROR / all usage_events in the window (per attempt).',
      worstToolFailure: `Highest FAILED / (SUCCEEDED + FAILED) over the last 24 h among tools with at least ${WORST_TOOL_MIN_CALLS} finished calls.`,
    },
  };
}

