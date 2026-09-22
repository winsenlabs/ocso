import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, iso, rounded } from '../analytics/values.js';
import { traceUrl } from './trace-links.js';

export interface LatencyPoint {
  minute: string;
  turnP50Ms: number | null;
  turnP95Ms: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  turns: number;
  requests: number;
  errors: number;
  fallbacks: number;
}

export interface LatencyMarker {
  minute: string;
  kind: 'fallback' | 'provider_errors';
  providerId: string | null;
  providerName: string | null;
  count: number;
  /** Most common error category for provider_errors markers. */
  errorCategory: string | null;
}

export interface SlowTurn {
  turnId: string;
  latencyMs: number | null;
  ttftMs: number | null;
  model: string | null;
  traceId: string | null;
  traceUrl: string | null;
  startedAt: string;
}

/** Percentiles over the whole window (not an average of per-minute percentiles). */
export interface LatencyWindow {
  turns: number;
  turnP50Ms: number | null;
  turnP95Ms: number | null;
  ttftRequests: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
}

export interface LatencySeries {
  minutes: number;
  window: LatencyWindow;
  points: LatencyPoint[];
  markers: LatencyMarker[];
  slowestTurns: SlowTurn[];
  traceUrlTemplate: string | null;
  definitions: Record<string, string>;
}

/**
 * Per-minute p50/p95 turn latency and TTFT for the last `minutes` minutes with
 * provider incident markers (design/03 latency chart). Turns via
 * turns_status_idx, model requests via usage_events_time_idx. Returns ids and
 * timings only — never conversation content.
 */
export async function latencySeries(db: DbOrTx, now: Date, minutes: number, traceUrlTemplate: string | null): Promise<LatencySeries> {
  const from = new Date(now.getTime() - minutes * 60_000);
  const [points, fallbackMarkers, errorMarkers, slow, whole] = await Promise.all([
    db.execute<{ m: Date; turn_p50: number | null; turn_p95: number | null; ttft_p50: number | null; ttft_p95: number | null; turns: number; requests: number; errors: number; fallbacks: number }>(sql`
      WITH mins AS (
        SELECT generate_series(date_trunc('minute', ${at(from)}) + interval '1 minute', date_trunc('minute', ${at(now)}), interval '1 minute') AS m
      ),
      t AS (
        SELECT date_trunc('minute', started_at) AS m,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, count(*)::int AS n
          FROM turns WHERE status = 'COMPLETED' AND started_at >= ${at(from)} AND started_at <= ${at(now)}
         GROUP BY 1
      ),
      u AS (
        SELECT date_trunc('minute', occurred_at) AS m,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE purpose = 'TURN' AND status = 'OK') AS ttft50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE purpose = 'TURN' AND status = 'OK') AS ttft,
               count(*)::int AS requests,
               count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
               count(*) FILTER (WHERE fallback_from_provider_id IS NOT NULL)::int AS fallbacks
          FROM usage_events WHERE occurred_at >= ${at(from)} AND occurred_at <= ${at(now)}
         GROUP BY 1
      )
      SELECT mins.m, t.p50 AS turn_p50, t.p95 AS turn_p95, u.ttft50 AS ttft_p50, u.ttft AS ttft_p95, coalesce(t.n, 0) AS turns,
             coalesce(u.requests, 0) AS requests, coalesce(u.errors, 0) AS errors, coalesce(u.fallbacks, 0) AS fallbacks
        FROM mins LEFT JOIN t ON t.m = mins.m LEFT JOIN u ON u.m = mins.m
       ORDER BY mins.m`),
    db.execute<{ m: Date; provider_id: string; name: string | null; n: number }>(sql`
      SELECT date_trunc('minute', u.occurred_at) AS m, u.fallback_from_provider_id AS provider_id, max(p.name) AS name, count(*)::int AS n
        FROM usage_events u LEFT JOIN model_providers p ON p.id = u.fallback_from_provider_id
       WHERE u.occurred_at >= ${at(from)} AND u.occurred_at <= ${at(now)} AND u.fallback_from_provider_id IS NOT NULL
       GROUP BY 1, 2 ORDER BY 1`),
    db.execute<{ m: Date; provider_id: string | null; name: string | null; n: number; category: string | null }>(sql`
      SELECT date_trunc('minute', u.occurred_at) AS m, u.provider_id, max(p.name) AS name, count(*)::int AS n,
             mode() WITHIN GROUP (ORDER BY u.error_category) AS category
        FROM usage_events u LEFT JOIN model_providers p ON p.id = u.provider_id
       WHERE u.occurred_at >= ${at(from)} AND u.occurred_at <= ${at(now)} AND u.status = 'ERROR'
       GROUP BY 1, 2 ORDER BY 1`),
    db.execute<{ id: string; latency_ms: number | null; ttft_ms: number | null; model: string | null; trace_id: string | null; started_at: Date }>(sql`
      SELECT id, latency_ms, ttft_ms, model, trace_id, started_at
        FROM turns WHERE status = 'COMPLETED' AND started_at >= ${at(from)} AND started_at <= ${at(now)} AND latency_ms IS NOT NULL
       ORDER BY latency_ms DESC LIMIT 5`),
    db.execute<{ turns: number; turn_p50: number | null; turn_p95: number | null; ttft_n: number; ttft_p50: number | null; ttft_p95: number | null }>(sql`
      SELECT t.turns, t.turn_p50, t.turn_p95, u.ttft_n, u.ttft_p50, u.ttft_p95
        FROM (SELECT count(*)::int AS turns,
                     percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS turn_p50,
                     percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS turn_p95
                FROM turns WHERE status = 'COMPLETED' AND started_at >= ${at(from)} AND started_at <= ${at(now)}) t,
             (SELECT count(ttft_ms)::int AS ttft_n,
                     percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p50,
                     percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p95
                FROM usage_events WHERE purpose = 'TURN' AND status = 'OK' AND occurred_at >= ${at(from)} AND occurred_at <= ${at(now)}) u`),
  ]);
  const w = whole.rows[0];
  return {
    minutes,
    window: {
      turns: int(w?.turns),
      turnP50Ms: rounded(w?.turn_p50),
      turnP95Ms: rounded(w?.turn_p95),
      ttftRequests: int(w?.ttft_n),
      ttftP50Ms: rounded(w?.ttft_p50),
      ttftP95Ms: rounded(w?.ttft_p95),
    },
    points: points.rows.map((r) => ({
      minute: iso(r.m)!,
      turnP50Ms: rounded(r.turn_p50),
      turnP95Ms: rounded(r.turn_p95),
      ttftP50Ms: rounded(r.ttft_p50),
      ttftP95Ms: rounded(r.ttft_p95),
      turns: int(r.turns),
      requests: int(r.requests),
      errors: int(r.errors),
      fallbacks: int(r.fallbacks),
    })),
    markers: [
      ...fallbackMarkers.rows.map((r): LatencyMarker => ({ minute: iso(r.m)!, kind: 'fallback', providerId: r.provider_id, providerName: r.name, count: int(r.n), errorCategory: null })),
      ...errorMarkers.rows.map((r): LatencyMarker => ({ minute: iso(r.m)!, kind: 'provider_errors', providerId: r.provider_id, providerName: r.name, count: int(r.n), errorCategory: r.category })),
    ].sort((a, b) => a.minute.localeCompare(b.minute)),
    slowestTurns: slow.rows.map((r) => ({
      turnId: r.id,
      latencyMs: r.latency_ms,
      ttftMs: r.ttft_ms,
      model: r.model,
      traceId: r.trace_id,
      traceUrl: traceUrl(traceUrlTemplate, r.trace_id),
      startedAt: iso(r.started_at)!,
    })),
    traceUrlTemplate,
    definitions: {
      turnP50Ms: 'p50 (median, continuous) of turns.latency_ms for COMPLETED turns started in the minute.',
      turnP95Ms: 'p95 of turns.latency_ms for COMPLETED turns started in the minute.',
      ttftP50Ms: 'p50 (median, continuous) of usage_events.ttft_ms for successful TURN requests in the minute.',
      ttftP95Ms: 'p95 of usage_events.ttft_ms for successful TURN requests in the minute.',
      window: 'turnP50Ms/turnP95Ms and ttftP50Ms/ttftP95Ms computed once over every row in the whole window (never averaged from per-minute values); turns = COMPLETED turns, ttftRequests = successful TURN requests reporting ttft_ms.',
      fallback: 'Minutes with usage_events whose fallback_from_provider_id is set (primary provider failed; request served by a fallback target).',
      provider_errors: 'Minutes with usage_events in status ERROR, per provider, with the most common error category.',
    },
  };
}
