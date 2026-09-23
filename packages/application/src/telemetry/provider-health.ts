import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, iso, num, ratio, rounded } from '../analytics/values.js';

export interface ProviderHealthCard {
  providerId: string;
  kind: string;
  name: string;
  enabled: boolean;
  status: string;
  region: string | null;
  residencyZone: string | null;
  lastHealthAt: string | null;
  lastHealthLatencyMs: number | null;
  lastError: string | null;
  /** Last hour. */
  requests1h: number;
  p95LatencyMs: number | null;
  errorRate: number | null;
  fallbacksFrom1h: number;
  /** Today (deployment timezone). */
  tokensToday: number;
  cacheReadShare: number | null;
  costTodayMicros: number | null;
  currency: string | null;
  /** Successful requests today without a price row (their cost is unknown). */
  unpricedRequestsToday: number;
  profiles: Array<{ id: string; name: string; role: 'PRIMARY' | 'FALLBACK'; cachePolicy: string }>;
  /** Observed, not assumed: whether this provider's responses reported cache reads today. */
  cacheSupport: 'REPORTED' | 'NOT_REPORTED' | 'NO_TRAFFIC';
}

/**
 * Per-provider health cards (design/03 "Model provider health"): configuration
 * and last health check from model_providers, request statistics from
 * usage_events_provider_idx, and the logical profiles that route to it.
 */
export async function providerHealth(db: DbOrTx, now: Date, dayStart: Date): Promise<ProviderHealthCard[]> {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [providers, hour, today, profiles] = await Promise.all([
    db.execute<{ id: string; kind: string; name: string; enabled: boolean; status: string; region: string | null; residency_zone: string | null; last_health_at: Date | null; last_health_latency_ms: number | null; last_error: string | null }>(sql`
      SELECT id, kind, name, enabled, status, region, residency_zone, last_health_at, last_health_latency_ms, last_error
        FROM model_providers ORDER BY enabled DESC, name`),
    db.execute<{ provider_id: string; n: number; errors: number; p95: number | null; fallbacks: number }>(sql`
      SELECT u.provider_id, count(*)::int AS n, count(*) FILTER (WHERE u.status = 'ERROR')::int AS errors,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY u.latency_ms) FILTER (WHERE u.status = 'OK') AS p95,
             (SELECT count(*)::int FROM usage_events f
               WHERE f.fallback_from_provider_id = u.provider_id AND f.occurred_at >= ${at(hourAgo)} AND f.occurred_at <= ${at(now)}) AS fallbacks
        FROM usage_events u
       WHERE u.provider_id IN (SELECT id FROM model_providers) AND u.occurred_at >= ${at(hourAgo)} AND u.occurred_at <= ${at(now)}
       GROUP BY u.provider_id`),
    db.execute<{ provider_id: string; tokens: number; cached: number | null; reported_input: number | null; cost: number | null; currencies: string[] | null; n: number; unpriced: number }>(sql`
      SELECT u.provider_id, count(*)::int AS n,
             coalesce(sum(u.input_tokens + u.output_tokens), 0)::float8 AS tokens,
             sum(u.cached_input_tokens)::float8 AS cached,
             (sum(u.input_tokens) FILTER (WHERE u.cached_input_tokens IS NOT NULL))::float8 AS reported_input,
             sum(u.cost_micros)::float8 AS cost,
             array_agg(DISTINCT u.currency) FILTER (WHERE u.currency IS NOT NULL) AS currencies,
             count(*) FILTER (WHERE u.status = 'OK' AND u.cost_micros IS NULL AND u.input_tokens + u.output_tokens > 0)::int AS unpriced
        FROM usage_events u
       WHERE u.provider_id IN (SELECT id FROM model_providers) AND u.occurred_at >= ${at(dayStart)} AND u.occurred_at <= ${at(now)}
       GROUP BY u.provider_id`),
    db.execute<{ id: string; name: string; provider_id: string; cache_policy: string; fallback_provider_ids: string[] | null }>(sql`
      SELECT id, name, provider_id, cache_policy,
             ARRAY(SELECT f ->> 'providerId' FROM jsonb_array_elements(fallbacks) f) AS fallback_provider_ids
        FROM model_profiles ORDER BY name`),
  ]);
  const hourBy = new Map(hour.rows.map((r) => [r.provider_id, r]));
  const todayBy = new Map(today.rows.map((r) => [r.provider_id, r]));
  return providers.rows.map((p) => {
    const h = hourBy.get(p.id);
    const d = todayBy.get(p.id);
    const cached = num(d?.cached);
    const reported = num(d?.reported_input);
    const currencies = d?.currencies ?? [];
    return {
      providerId: p.id,
      kind: p.kind,
      name: p.name,
      enabled: p.enabled,
      status: p.status,
      region: p.region,
      residencyZone: p.residency_zone,
      lastHealthAt: iso(p.last_health_at),
      lastHealthLatencyMs: p.last_health_latency_ms,
      lastError: p.last_error,
      requests1h: int(h?.n),
      p95LatencyMs: rounded(h?.p95),
      errorRate: ratio(int(h?.errors), int(h?.n)),
      fallbacksFrom1h: int(h?.fallbacks),
      tokensToday: int(d?.tokens),
      cacheReadShare: cached !== null && reported ? cached / reported : null,
      costTodayMicros: num(d?.cost),
      currency: currencies.length === 0 ? null : currencies.length === 1 ? currencies[0]! : 'MIXED',
      unpricedRequestsToday: int(d?.unpriced),
      profiles: profiles.rows.flatMap((pr): ProviderHealthCard['profiles'] => {
        if (pr.provider_id === p.id) return [{ id: pr.id, name: pr.name, role: 'PRIMARY', cachePolicy: pr.cache_policy }];
        if ((pr.fallback_provider_ids ?? []).includes(p.id)) return [{ id: pr.id, name: pr.name, role: 'FALLBACK', cachePolicy: pr.cache_policy }];
        return [];
      }),
      cacheSupport: !d || int(d.n) === 0 ? 'NO_TRAFFIC' : reported ? 'REPORTED' : 'NOT_REPORTED',
    };
  });
}
