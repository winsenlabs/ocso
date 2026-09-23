import { and, eq, inArray, sql } from 'drizzle-orm';
import { fingerprint, formatCount, formatMicros, formatPercent } from '@ocso/alerts';
import { alerts, modelPricing } from '@ocso/db';
import { selectPrice, usageCostMicros } from '@ocso/model-providers';
import { z } from 'zod';
import { defineEvaluator, type EvaluationContext } from './contract.js';
import { agentClause, at, num, observe, queryRows } from './support.js';

const Params = z
  .object({
    monthlyBudgetUsd: z.number().positive().max(100_000_000).describe('Monthly model spend budget in USD'),
    thresholdsPercent: z
      .array(z.number().positive().max(1000))
      .min(1)
      .max(10)
      .refine((t) => new Set(t).size === t.length, 'thresholds must be distinct')
      .default([80, 100])
      .describe('Percent of the budget that alerts, e.g. [80, 100]; each fires once per calendar month'),
  })
  .strict();

interface Month {
  month_start: Date;
  month_end: Date;
  label: string;
  timezone: string;
  agent_name: string | null;
}

interface Spend {
  recorded: number;
  non_usd: number;
}

interface UnpricedGroup {
  provider_kind: string;
  model: string;
  n: number;
  input: number;
  uncached: number;
  cached: number | null;
  cache_write: number | null;
  output: number;
}

/**
 * Month-to-date model spend of this calendar month (deployment timezone) in
 * USD: recorded usage_events.cost_micros (USD rows), plus requests recorded
 * without a cost that a model_pricing row prices now (priced per model at
 * the average input size, so long-context tiers are approximate for them).
 * Requests still without a price are counted and named, never valued at 0.
 */
async function monthToDate(ctx: EvaluationContext<z.output<typeof Params>>) {
  const [month] = await queryRows<Month>(
    ctx.db,
    sql`WITH tz AS (SELECT coalesce((SELECT timezone FROM deployment_settings WHERE id = 1), 'UTC') AS name),
             m AS (SELECT date_trunc('month', ${at(ctx.now)} AT TIME ZONE tz.name) AS local_start, tz.name FROM tz)
        SELECT (m.local_start AT TIME ZONE m.name) AS month_start,
               ((m.local_start + interval '1 month') AT TIME ZONE m.name) AS month_end,
               to_char(m.local_start, 'YYYY-MM') AS label, m.name AS timezone,
               (SELECT name FROM virtual_agents WHERE id = ${ctx.rule.agentId}::uuid) AS agent_name
          FROM m`,
  );
  const start = new Date(month!.month_start);
  const window = sql`occurred_at >= ${at(start)} AND occurred_at <= ${at(ctx.now)} ${agentClause(sql`agent_id`, ctx.rule.agentId)}`;
  const [spend] = await queryRows<Spend>(
    ctx.db,
    sql`SELECT coalesce(sum(cost_micros) FILTER (WHERE currency = 'USD'), 0)::float8 AS recorded,
               count(*) FILTER (WHERE cost_micros IS NOT NULL AND currency IS DISTINCT FROM 'USD')::int AS non_usd
          FROM usage_events WHERE ${window}`,
  );
  const groups = await queryRows<UnpricedGroup>(
    ctx.db,
    sql`SELECT provider_kind, model, count(*)::int AS n,
               sum(input_tokens)::float8 AS input, sum(uncached_input_tokens)::float8 AS uncached,
               sum(cached_input_tokens)::float8 AS cached, sum(cache_write_tokens)::float8 AS cache_write,
               sum(output_tokens)::float8 AS output
          FROM usage_events
         WHERE ${window} AND status = 'OK' AND cost_micros IS NULL AND input_tokens + output_tokens > 0
           AND provider_kind IS NOT NULL AND model IS NOT NULL
         GROUP BY 1, 2`,
  );
  const prices = groups.length ? await ctx.db.select().from(modelPricing) : [];
  let repriced = 0;
  let unpriced = 0;
  const unpricedModels: string[] = [];
  for (const g of groups) {
    const price = selectPrice(prices, g.provider_kind, g.model, ctx.now);
    const n = num(g.n);
    if (!price || price.currency !== 'USD') {
      unpriced += n;
      unpricedModels.push(`${g.provider_kind.toLowerCase()} ${g.model}`);
      continue;
    }
    repriced += usageCostMicros(price, {
      inputTokens: n ? num(g.input) / n : 0,
      uncachedInputTokens: num(g.uncached),
      cachedInputTokens: g.cached === null ? null : num(g.cached),
      cacheWriteTokens: g.cache_write === null ? null : num(g.cache_write),
      outputTokens: num(g.output),
    });
  }
  return { month: month!, start, end: new Date(month!.month_end), spend: num(spend?.recorded) + repriced, repriced, unpriced, unpricedModels, nonUsd: num(spend?.non_usd) };
}

export const spendBudgetAbove = defineEvaluator({
  condition: 'spend_budget_above',
  label: 'Monthly model spend above budget',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'Month-to-date model spend for the current calendar month in the deployment timezone: sum of usage_events.cost_micros in USD, plus requests recorded without a cost that a model_pricing row prices now (at that model\'s average input size). Requests with no price are reported, not counted as zero; non-USD costs are excluded. Fires once per calendar month for each threshold in `thresholdsPercent` of `monthlyBudgetUsd` that spend reaches; the alert resolves when the month rolls over. The body projects month-end spend at the month-to-date run rate (spend × month length / elapsed time).',
  params: Params,
  async evaluate(ctx) {
    const m = await monthToDate(ctx);
    const budgetMicros = Math.round(ctx.params.monthlyBudgetUsd * 1_000_000);
    const elapsed = Math.max(1, ctx.now.getTime() - m.start.getTime());
    const projected = Math.round((m.spend * (m.end.getTime() - m.start.getTime())) / elapsed);
    const subject = m.month.agent_name ?? 'all agents';
    // Budget and month are part of the scope: a new month (or a changed budget) is a new alert.
    const scopes = ctx.params.thresholdsPercent.map((t) => ({ month: m.month.label, thresholdPercent: t, budgetMicros, agentId: ctx.rule.agentId }));
    const reached = scopes.filter((s) => m.spend >= (budgetMicros * s.thresholdPercent) / 100);
    // Once per threshold per month: a threshold alert already resolved this month (by a person) does not reopen.
    const done = reached.length
      ? new Set(
          (
            await ctx.db
              .select({ fingerprint: alerts.fingerprint })
              .from(alerts)
              .where(and(eq(alerts.ruleId, ctx.rule.id), eq(alerts.status, 'RESOLVED'), inArray(alerts.fingerprint, reached.map((s) => fingerprint(ctx.rule.id, s)))))
          ).map((r) => r.fingerprint),
        )
      : new Set<string>();
    const share = m.spend / budgetMicros;
    const notes = [
      m.unpriced ? `${formatCount(m.unpriced)} request(s) have no price and are not counted (${m.unpricedModels.slice(0, 5).join(', ')})` : null,
      m.nonUsd ? `${formatCount(m.nonUsd)} request(s) priced in another currency are excluded` : null,
    ].filter(Boolean);
    return reached
      .filter((s) => !done.has(fingerprint(ctx.rule.id, s)))
      .map((s) =>
        observe(ctx, s, {
          firing: true,
          title: `Monthly model spend reached ${s.thresholdPercent}% of budget · ${subject}`,
          value: formatPercent(share),
          body:
            `Model spend for ${subject} in ${m.month.label} (${m.month.timezone}) is ${formatMicros(m.spend)} of the ${formatMicros(budgetMicros)} monthly budget (${formatPercent(share)}; threshold ${s.thresholdPercent}%). ` +
            `Projected month-end spend at the current run rate: ${formatMicros(projected)}.` +
            (notes.length ? ` ${notes.join('; ')}.` : ''),
          source: 'Model usage · spend',
          context: {
            month: m.month.label,
            timezone: m.month.timezone,
            monthStart: m.start.toISOString(),
            monthEnd: m.end.toISOString(),
            budgetMicros,
            thresholdPercent: s.thresholdPercent,
            spendMicros: m.spend,
            repricedMicros: m.repriced,
            projectedMonthEndMicros: projected,
            unpricedRequests: m.unpriced,
            unpricedModels: m.unpricedModels.slice(0, 20),
            nonUsdRequests: m.nonUsd,
          },
        }),
      );
  },
});
