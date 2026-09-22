import { and, gte, inArray, sql } from 'drizzle-orm';
import { usageEvents, type DbOrTx } from '@ocso/db';

/** Rolling 24h usage figures for a provider or profile (docs/05 §3, ADR-016 read model). */
export interface ModelUsageStats {
  requests: number;
  errors: number;
  /** errors / requests, 0..1; null when there were no requests. */
  errorRate: number | null;
  p95LatencyMs: number | null;
  p95TtftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** cached input / input, over requests whose provider reports cache reads; null when none do. */
  cacheReadRatio: number | null;
  costMicros: number | null;
  /** Currency of `costMicros`; `MIXED` when prices span currencies. */
  currency: string | null;
}

export const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

export const EMPTY_USAGE_STATS: ModelUsageStats = {
  requests: 0,
  errors: 0,
  errorRate: null,
  p95LatencyMs: null,
  p95TtftMs: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadRatio: null,
  costMicros: null,
  currency: null,
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 24h stats per provider or per profile, keyed by id (ids without traffic are absent). */
export async function modelUsageStats(
  db: DbOrTx,
  by: 'provider' | 'profile',
  ids: readonly string[],
  now: Date,
): Promise<Map<string, ModelUsageStats>> {
  if (!ids.length) return new Map();
  const key = by === 'provider' ? usageEvents.providerId : usageEvents.profileId;
  const u = usageEvents;
  const rows = await db
    .select({
      key,
      requests: sql`count(*)`.mapWith(Number),
      errors: sql`count(*) filter (where ${u.status} = 'ERROR')`.mapWith(Number),
      p95LatencyMs: sql`percentile_cont(0.95) within group (order by ${u.latencyMs})`,
      p95TtftMs: sql`percentile_cont(0.95) within group (order by ${u.ttftMs})`,
      inputTokens: sql`coalesce(sum(${u.inputTokens}), 0)`.mapWith(Number),
      outputTokens: sql`coalesce(sum(${u.outputTokens}), 0)`.mapWith(Number),
      cachedTokens: sql`sum(${u.cachedInputTokens})`,
      cacheReportedInput: sql`sum(${u.inputTokens}) filter (where ${u.cachedInputTokens} is not null)`,
      costMicros: sql`sum(${u.costMicros})`,
      currencies: sql<string[] | null>`array_agg(distinct ${u.currency}) filter (where ${u.currency} is not null)`,
    })
    .from(u)
    .where(and(gte(u.occurredAt, new Date(now.getTime() - STATS_WINDOW_MS)), inArray(key, [...ids])))
    .groupBy(key);

  const stats = new Map<string, ModelUsageStats>();
  for (const r of rows) {
    if (!r.key) continue;
    const cached = num(r.cachedTokens);
    const reportedInput = num(r.cacheReportedInput);
    const p95Latency = num(r.p95LatencyMs);
    const p95Ttft = num(r.p95TtftMs);
    const currencies = r.currencies ?? [];
    stats.set(r.key, {
      requests: r.requests,
      errors: r.errors,
      errorRate: r.requests ? r.errors / r.requests : null,
      p95LatencyMs: p95Latency === null ? null : Math.round(p95Latency),
      p95TtftMs: p95Ttft === null ? null : Math.round(p95Ttft),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadRatio: cached !== null && reportedInput ? cached / reportedInput : null,
      costMicros: num(r.costMicros),
      currency: currencies.length === 0 ? null : currencies.length === 1 ? currencies[0]! : 'MIXED',
    });
  }
  return stats;
}
