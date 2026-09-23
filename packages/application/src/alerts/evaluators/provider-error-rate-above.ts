import { sql } from 'drizzle-orm';
import { formatCount, formatPercent } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    thresholdPercent: z.number().gt(0).max(100).default(5),
    minRequests: z.number().int().min(1).max(1_000_000).default(20),
  })
  .strict();

interface Row {
  provider_id: string;
  name: string;
  total: number;
  errors: number;
  categories: Record<string, number> | null;
}

export const providerErrorRateAbove = defineEvaluator({
  condition: 'provider_error_rate_above',
  label: 'Provider error rate above threshold',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'Per model provider, usage_events in the window: errors = rows with status ERROR, rate = errors / all rows. Providers with fewer than `minRequests` requests are not judged. Fires when rate > `thresholdPercent`.',
  params: Params,
  async evaluate(ctx) {
    const rows = await queryRows<Row>(
      ctx.db,
      sql`SELECT u.provider_id::text AS provider_id,
                 coalesce(max(p.name), max(u.provider_kind), 'unknown provider') AS name,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE u.status = 'ERROR')::int AS errors,
                 (SELECT jsonb_object_agg(cat, n) FROM (
                    SELECT coalesce(e.error_category, 'unknown') AS cat, count(*)::int AS n
                      FROM usage_events e
                     WHERE e.provider_id = u.provider_id AND e.status = 'ERROR'
                       AND e.occurred_at >= ${at(ctx.window.start)} AND e.occurred_at <= ${at(ctx.now)}
                       ${agentClause(sql`e.agent_id`, ctx.rule.agentId)}
                     GROUP BY 1 ORDER BY 2 DESC LIMIT 5) c) AS categories
            FROM usage_events u
            LEFT JOIN model_providers p ON p.id = u.provider_id
           WHERE u.provider_id IS NOT NULL
             AND u.occurred_at >= ${at(ctx.window.start)} AND u.occurred_at <= ${at(ctx.now)}
             ${agentClause(sql`u.agent_id`, ctx.rule.agentId)}
           GROUP BY u.provider_id`,
    );
    const threshold = ctx.params.thresholdPercent / 100;
    return rows.map((r) => {
      const total = num(r.total);
      const errors = num(r.errors);
      const rate = total ? errors / total : 0;
      return observe(ctx, { providerId: r.provider_id }, {
        firing: total >= ctx.params.minRequests && rate > threshold,
        title: `Provider error rate above ${formatPercent(threshold)} · ${r.name}`,
        value: formatPercent(rate),
        body: `${formatCount(errors)} of ${formatCount(total)} model requests to ${r.name} failed (${formatPercent(rate)}) ${windowPhrase(ctx)}; threshold ${formatPercent(threshold)}, minimum volume ${formatCount(ctx.params.minRequests)}.`,
        source: `Provider · ${r.name}`,
        context: { providerId: r.provider_id, total, errors, rate, thresholdPercent: ctx.params.thresholdPercent, errorCategories: r.categories ?? {} },
      });
    });
  },
});
