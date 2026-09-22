import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, iso, rounded } from '../analytics/values.js';
import { traceUrl } from './trace-links.js';

export interface LatencyPoint {
  minute: string;
  turnP95Ms: number | null;
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

export interface LatencySeries {
  minutes: number;
  points: LatencyPoint[];
  markers: LatencyMarker[];
  slowestTurns: SlowTurn[];
  traceUrlTemplate: string | null;
  definitions: Record<string, string>;
}

/**
 * Per-minute p95 turn latency and TTFT for the last `minutes` minutes with
 * provider incident markers (design/03 latency chart). Turns via
 * turns_status_idx, model requests via usage_events_time_idx. Returns ids and
 * timings only — never conversation content.
 */
export async function latencySeries(db: DbOrTx, now: Date, minutes: number, traceUrlTemplate: string | null): Promise<LatencySeries> {
  const from = new Date(now.getTime() - minutes * 60_000);
  const [points, fallbackMarkers, errorMarkers, slow] = await Promise.all([
    db.execute<{ m: Date; turn_p95: number | null; ttft_p95: number | null; turns: number; requests: number; errors: number; fallbacks: number }>(sql`
      WITH mins AS (
        SELECT generate_series(date_trunc('minute', ${at(from)}) + interval '1 minute', date_trunc('minute', ${at(now)}), interval '1 minute') AS m
      ),
      t AS (
        SELECT date_trunc('minute', started_at) AS m, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, count(*)::int AS n
          FROM turns WHERE status = 'COMPLETED' AND started_at >= ${at(from)} AND started_at <= ${at(now)}
         GROUP BY 1
      ),
      u AS (
        SELECT date_trunc('minute', occurred_at) AS m,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE purpose = 'TURN' AND status = 'OK') AS ttft,
               count(*)::int AS requests,
               count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
               count(*) FILTER (WHERE fallback_from_provider_id IS NOT NULL)::int AS fallbacks
          FROM usage_events WHERE occurred_at >= ${at(from)} AND occurred_at <= ${at(now)}
         GROUP BY 1
      )
      SELECT mins.m, t.p95 AS turn_p95, u.ttft AS ttft_p95, coalesce(t.n, 0) AS turns,
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
  ]);
  return {
    minutes,
    points: points.rows.map((r) => ({
      minute: iso(r.m)!,
      turnP95Ms: rounded(r.turn_p95),
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
      turnP95Ms: 'p95 of turns.latency_ms for COMPLETED turns started in the minute.',
      ttftP95Ms: 'p95 of usage_events.ttft_ms for successful TURN requests in the minute.',
      fallback: 'Minutes with usage_events whose fallback_from_provider_id is set (primary provider failed; request served by a fallback target).',
      provider_errors: 'Minutes with usage_events in status ERROR, per provider, with the most common error category.',
    },
  };
}
