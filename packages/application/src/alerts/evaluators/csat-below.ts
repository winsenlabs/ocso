import { sql } from 'drizzle-orm';
import { formatCount } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, numOrNull, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    /** Average score floor on the 1–5 CSAT scale. */
    threshold: z.number().min(1).max(5).default(4),
    minResponses: z.number().int().min(1).max(1_000_000).default(20),
  })
  .strict();

interface Row {
  agent_id: string;
  agent_name: string | null;
  n: number;
  avg: number;
  avg_ai: number | null;
  avg_human: number | null;
}

const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(2));

export const csatBelow = defineEvaluator({
  condition: 'csat_below',
  label: 'CSAT below floor',
  kinds: ['BUSINESS'],
  agentScoped: true,
  method:
    'Per virtual agent, arithmetic mean of csat_responses.score received in the window (split into AI-handled and human-handled for context). Needs at least `minResponses` responses. Fires when the mean < `threshold`.',
  params: Params,
  async evaluate(ctx) {
    const rows = await queryRows<Row>(
      ctx.db,
      sql`SELECT r.agent_id::text AS agent_id, max(a.name) AS agent_name, count(*)::int AS n,
                 avg(r.score)::float8 AS avg,
                 (avg(r.score) FILTER (WHERE NOT r.handled_by_human))::float8 AS avg_ai,
                 (avg(r.score) FILTER (WHERE r.handled_by_human))::float8 AS avg_human
            FROM csat_responses r
            LEFT JOIN virtual_agents a ON a.id = r.agent_id
           WHERE r.received_at >= ${at(ctx.window.start)} AND r.received_at <= ${at(ctx.now)}
             ${agentClause(sql`r.agent_id`, ctx.rule.agentId)}
           GROUP BY r.agent_id`,
    );
    return rows.map((r) => {
      const n = num(r.n);
      const avg = num(r.avg);
      const agent = r.agent_name ?? 'unknown agent';
      return observe(ctx, { agentId: r.agent_id }, {
        firing: n >= ctx.params.minResponses && avg < ctx.params.threshold,
        agentId: r.agent_id,
        title: `CSAT below ${ctx.params.threshold.toFixed(1)} · ${agent}`,
        value: avg.toFixed(2),
        body: `Average CSAT ${avg.toFixed(2)} over ${formatCount(n)} response(s) for ${agent} ${windowPhrase(ctx)} (AI-handled ${fmt(numOrNull(r.avg_ai))}, human-handled ${fmt(numOrNull(r.avg_human))}); floor ${ctx.params.threshold.toFixed(1)}, minimum ${formatCount(ctx.params.minResponses)} responses.`,
        source: `Agent · ${agent}`,
        context: { responses: n, average: avg, averageAi: numOrNull(r.avg_ai), averageHuman: numOrNull(r.avg_human), threshold: ctx.params.threshold },
      });
    });
  },
});
