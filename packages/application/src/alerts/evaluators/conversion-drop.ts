import { sql } from 'drizzle-orm';
import { baselineWindow, formatCount, formatPercent } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, observe, queryRows, textList } from './support.js';

const Params = z
  .object({
    /** Relative drop vs baseline that fires, e.g. 30 = current rate below 70% of baseline. */
    dropPercent: z.number().gt(0).lt(100).default(30),
    minOutcomes: z.number().int().min(1).max(1_000_000).default(20),
    baselineWindows: z.number().int().min(1).max(168).default(7),
    /** salesOutcome values (case-insensitive) that count as a conversion. */
    convertedOutcomes: z.array(z.string().trim().min(1).max(60)).min(1).max(20).default(['CONVERTED', 'WON']),
  })
  .strict();

interface Row {
  agent_id: string;
  agent_name: string | null;
  n_cur: number;
  conv_cur: number;
  n_base: number;
  conv_base: number;
}

export const conversionDrop = defineEvaluator({
  condition: 'conversion_drop',
  label: 'Conversion drop vs baseline',
  kinds: ['BUSINESS'],
  agentScoped: true,
  method:
    'Per virtual agent, conversation_insights with a non-null salesOutcome. Conversion rate = rows whose salesOutcome is in `convertedOutcomes` / all rows with a salesOutcome. Compares the window rate with the rate over the previous `baselineWindows` windows. Both periods need `minOutcomes`. Fires when current < baseline × (1 − dropPercent/100).',
  params: Params,
  async evaluate(ctx) {
    const baseline = baselineWindow(ctx.now, ctx.rule.windowSeconds, ctx.params.baselineWindows);
    const converted = ctx.params.convertedOutcomes.map((o) => o.toUpperCase());
    const rows = await queryRows<Row>(
      ctx.db,
      sql`SELECT i.agent_id::text AS agent_id, max(a.name) AS agent_name,
                 count(*) FILTER (WHERE i.cur)::int AS n_cur,
                 count(*) FILTER (WHERE i.cur AND i.conv)::int AS conv_cur,
                 count(*) FILTER (WHERE NOT i.cur)::int AS n_base,
                 count(*) FILTER (WHERE NOT i.cur AND i.conv)::int AS conv_base
            FROM (SELECT agent_id,
                         generated_at >= ${at(ctx.window.start)} AS cur,
                         upper(trim(sales_outcome)) IN (${textList(converted)}) AS conv
                    FROM conversation_insights
                   WHERE sales_outcome IS NOT NULL
                     AND generated_at >= ${at(baseline.start)} AND generated_at <= ${at(ctx.now)}
                     ${agentClause(sql`agent_id`, ctx.rule.agentId)}) i
            LEFT JOIN virtual_agents a ON a.id = i.agent_id
           GROUP BY i.agent_id`,
    );
    const drop = ctx.params.dropPercent / 100;
    return rows.map((r) => {
      const nCur = num(r.n_cur);
      const nBase = num(r.n_base);
      const cur = nCur ? num(r.conv_cur) / nCur : 0;
      const base = nBase ? num(r.conv_base) / nBase : 0;
      const enough = nCur >= ctx.params.minOutcomes && nBase >= ctx.params.minOutcomes;
      const agent = r.agent_name ?? 'unknown agent';
      return observe(ctx, { agentId: r.agent_id }, {
        firing: enough && base > 0 && cur < base * (1 - drop),
        agentId: r.agent_id,
        title: `Conversion drop · ${agent}`,
        value: formatPercent(cur),
        body: `Conversion ${formatPercent(cur)} (${formatCount(num(r.conv_cur))}/${formatCount(nCur)}) for ${agent} in the current window vs ${formatPercent(base)} (${formatCount(num(r.conv_base))}/${formatCount(nBase)}) over the previous ${ctx.params.baselineWindows} window(s); fires below ${formatPercent(base * (1 - drop))} (−${ctx.params.dropPercent}%).`,
        source: `Agent · ${agent}`,
        context: { currentRate: cur, baselineRate: base, currentOutcomes: nCur, baselineOutcomes: nBase, baselineStart: baseline.start.toISOString(), ...ctx.params },
      });
    });
  },
});
