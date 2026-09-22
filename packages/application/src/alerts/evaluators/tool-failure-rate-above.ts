import { sql } from 'drizzle-orm';
import { formatCount, formatPercent } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { at, num, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    thresholdPercent: z.number().gt(0).max(100).default(5),
    minCalls: z.number().int().min(1).max(1_000_000).default(10),
  })
  .strict();

interface Row {
  tool_name: string;
  connection_id: string | null;
  connection_name: string | null;
  calls: number;
  failures: number;
  categories: Record<string, number> | null;
}

export const toolFailureRateAbove = defineEvaluator({
  condition: 'tool_failure_rate_above',
  label: 'Tool failure rate above threshold',
  kinds: ['BUSINESS', 'TECHNICAL'],
  agentScoped: true,
  method:
    'Per tool, tool_calls that finished in the window (requested in the window with status SUCCEEDED or FAILED; denied/expired calls are policy outcomes, not failures). Rate = FAILED / finished. Agent-bound rules count calls from that agent\'s conversations. Needs `minCalls`. Fires when rate > `thresholdPercent`.',
  params: Params,
  async evaluate(ctx) {
    const agentJoin = ctx.rule.agentId
      ? sql` JOIN conversations c ON c.id = tc.conversation_id AND c.agent_id = ${ctx.rule.agentId}::uuid`
      : sql``;
    const rows = await queryRows<Row>(
      ctx.db,
      sql`WITH finished AS (
            SELECT tc.tool_name, tc.connection_id, tc.status, tc.error_category
              FROM tool_calls tc ${agentJoin}
             WHERE tc.status IN ('SUCCEEDED', 'FAILED')
               AND tc.requested_at >= ${at(ctx.window.start)} AND tc.requested_at <= ${at(ctx.now)}
          )
          SELECT f.tool_name,
                 max(f.connection_id::text) AS connection_id,
                 max(m.name) AS connection_name,
                 count(*)::int AS calls,
                 count(*) FILTER (WHERE f.status = 'FAILED')::int AS failures,
                 (SELECT jsonb_object_agg(cat, n) FROM (
                    SELECT coalesce(g.error_category, 'unknown') AS cat, count(*)::int AS n FROM finished g
                     WHERE g.tool_name = f.tool_name AND g.status = 'FAILED'
                     GROUP BY 1 ORDER BY 2 DESC LIMIT 5) e) AS categories
            FROM finished f
            LEFT JOIN mcp_connections m ON m.id = f.connection_id
           GROUP BY f.tool_name`,
    );
    const threshold = ctx.params.thresholdPercent / 100;
    return rows.map((r) => {
      const calls = num(r.calls);
      const failures = num(r.failures);
      const rate = calls ? failures / calls : 0;
      const via = r.connection_name ? ` (${r.connection_name})` : '';
      return observe(ctx, { tool: r.tool_name }, {
        firing: calls >= ctx.params.minCalls && rate > threshold,
        title: `Tool failure rate above ${formatPercent(threshold)} · ${r.tool_name}`,
        value: formatPercent(rate),
        body: `${formatCount(failures)} of ${formatCount(calls)} calls to ${r.tool_name}${via} failed ${windowPhrase(ctx)} (${formatPercent(rate)}); threshold ${formatPercent(threshold)}, minimum volume ${formatCount(ctx.params.minCalls)}.`,
        source: `Tool · ${r.tool_name}`,
        context: { toolName: r.tool_name, connectionId: r.connection_id, calls, failures, rate, thresholdPercent: ctx.params.thresholdPercent, errorCategories: r.categories ?? {} },
      });
    });
  },
});
