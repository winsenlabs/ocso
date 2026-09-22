import { sql } from 'drizzle-orm';
import { formatCount, formatDurationMs } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, numOrNull, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    thresholdMs: z.number().int().min(1).max(120_000).default(3000),
    minRequests: z.number().int().min(1).max(1_000_000).default(10),
  })
  .strict();

interface Row {
  profile_id: string | null;
  profile_name: string | null;
  n: number;
  p95: number | null;
}

export const ttftP95Above = defineEvaluator({
  condition: 'ttft_p95_above',
  label: 'Time to first token p95 above threshold',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'Per model profile, p95 (percentile_cont 0.95) of usage_events.ttft_ms for successful streamed requests in the window. Profiles with fewer than `minRequests` samples are not judged. Fires when p95 > `thresholdMs`.',
  params: Params,
  async evaluate(ctx) {
    const rows = await queryRows<Row>(
      ctx.db,
      sql`SELECT u.profile_id::text AS profile_id, max(mp.name) AS profile_name, count(*)::int AS n,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY u.ttft_ms)::float8 AS p95
            FROM usage_events u
            LEFT JOIN model_profiles mp ON mp.id = u.profile_id
           WHERE u.ttft_ms IS NOT NULL AND u.status = 'OK'
             AND u.occurred_at >= ${at(ctx.window.start)} AND u.occurred_at <= ${at(ctx.now)}
             ${agentClause(sql`u.agent_id`, ctx.rule.agentId)}
           GROUP BY u.profile_id`,
    );
    const threshold = ctx.params.thresholdMs;
    return rows.map((r) => {
      const n = num(r.n);
      const p95 = numOrNull(r.p95);
      const name = r.profile_name ?? 'unprofiled requests';
      return observe(ctx, { profileId: r.profile_id ?? 'none' }, {
        firing: n >= ctx.params.minRequests && p95 !== null && p95 > threshold,
        title: `TTFT p95 above ${formatDurationMs(threshold)} · ${name}`,
        value: p95 === null ? 'no data' : `p95 ${formatDurationMs(p95)}`,
        body: `Time to first token p95 ${p95 === null ? 'n/a' : formatDurationMs(p95)} over ${formatCount(n)} request(s) on ${name} ${windowPhrase(ctx)}; threshold ${formatDurationMs(threshold)}.`,
        source: `Model profile · ${name}`,
        context: { profileId: r.profile_id, requests: n, p95Ms: p95, thresholdMs: threshold },
      });
    });
  },
});
