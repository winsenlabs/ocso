import { sql } from 'drizzle-orm';
import { formatCount, formatDurationMs } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { at, num, numOrNull, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    component: z.string().trim().min(1).max(60).default('database'),
    latencyThresholdMs: z.number().int().min(1).max(60_000).default(250),
    minSamples: z.number().int().min(1).max(10_000).default(1),
  })
  .strict();

export const databaseDegraded = defineEvaluator({
  condition: 'database_degraded',
  label: 'Database degraded',
  kinds: ['TECHNICAL'],
  agentScoped: false,
  method:
    'health_samples for `component` (default "database") in the window. Fires when the most recent sample is DEGRADED or DOWN, or when the p95 round-trip latency exceeds `latencyThresholdMs`. Needs at least `minSamples` samples; no samples → not judged.',
  params: Params,
  async evaluate(ctx) {
    const [row] = await queryRows<{ n: number; unhealthy: number; latest: string | null; p95: number | null }>(
      ctx.db,
      sql`SELECT count(*)::int AS n,
                 count(*) FILTER (WHERE status <> 'OK')::int AS unhealthy,
                 (array_agg(status ORDER BY sampled_at DESC))[1] AS latest,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95
            FROM health_samples
           WHERE component = ${ctx.params.component}
             AND sampled_at >= ${at(ctx.window.start)} AND sampled_at <= ${at(ctx.now)}`,
    );
    const n = num(row?.n);
    const p95 = numOrNull(row?.p95);
    const latest = row?.latest ?? null;
    const statusBad = latest === 'DEGRADED' || latest === 'DOWN';
    const slow = p95 !== null && p95 > ctx.params.latencyThresholdMs;
    const reason = statusBad ? `latest sample ${latest}` : slow ? 'round-trip latency above threshold' : 'healthy';
    return [
      observe(ctx, { component: ctx.params.component }, {
        firing: n >= ctx.params.minSamples && (statusBad || slow),
        title: `Database degraded · ${ctx.params.component}`,
        value: latest && statusBad ? latest.toLowerCase() : p95 === null ? 'no data' : `p95 ${formatDurationMs(p95)}`,
        body: `${formatCount(n)} health sample(s) for ${ctx.params.component} ${windowPhrase(ctx)}: ${formatCount(num(row?.unhealthy))} not OK, p95 round-trip ${p95 === null ? 'n/a' : formatDurationMs(p95)} (threshold ${formatDurationMs(ctx.params.latencyThresholdMs)}); ${reason}.`,
        source: 'Database',
        context: { samples: n, unhealthySamples: num(row?.unhealthy), latestStatus: latest, p95Ms: p95, latencyThresholdMs: ctx.params.latencyThresholdMs },
      }),
    ];
  },
});
