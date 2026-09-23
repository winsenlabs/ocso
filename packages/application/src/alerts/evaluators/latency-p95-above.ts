import { sql } from 'drizzle-orm';
import { formatCount, formatDurationMs } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, numOrNull, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    thresholdMs: z.number().int().min(1).max(600_000).default(8000),
    minTurns: z.number().int().min(1).max(1_000_000).default(10),
  })
  .strict();

export const latencyP95Above = defineEvaluator({
  condition: 'latency_p95_above',
  label: 'Turn latency p95 above threshold',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'p95 (percentile_cont 0.95) of turns.latency_ms for turns COMPLETED in the window, optionally for one agent. Needs at least `minTurns` turns. Fires when p95 > `thresholdMs`.',
  params: Params,
  async evaluate(ctx) {
    const [row] = await queryRows<{ n: number; p95: number | null; p50: number | null; agent_name: string | null }>(
      ctx.db,
      sql`SELECT count(*)::int AS n,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY t.latency_ms)::float8 AS p95,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms)::float8 AS p50,
                 (SELECT name FROM virtual_agents WHERE id = ${ctx.rule.agentId}::uuid) AS agent_name
            FROM turns t
            JOIN conversations c ON c.id = t.conversation_id
           WHERE t.status = 'COMPLETED' AND t.latency_ms IS NOT NULL
             AND t.completed_at >= ${at(ctx.window.start)} AND t.completed_at <= ${at(ctx.now)}
             ${agentClause(sql`c.agent_id`, ctx.rule.agentId)}`,
    );
    const n = num(row?.n);
    const p95 = numOrNull(row?.p95);
    const subject = row?.agent_name ?? 'all agents';
    const threshold = ctx.params.thresholdMs;
    return [
      observe(ctx, { agentId: ctx.rule.agentId }, {
        firing: n >= ctx.params.minTurns && p95 !== null && p95 > threshold,
        title: `Turn latency p95 above ${formatDurationMs(threshold)} · ${subject}`,
        value: p95 === null ? 'no data' : `p95 ${formatDurationMs(p95)}`,
        body: `End-to-end turn latency p95 ${p95 === null ? 'n/a' : formatDurationMs(p95)} (p50 ${row?.p50 == null ? 'n/a' : formatDurationMs(num(row.p50))}) over ${formatCount(n)} completed turn(s) ${windowPhrase(ctx)} for ${subject}; threshold ${formatDurationMs(threshold)}.`,
        source: ctx.rule.agentId ? `Agent · ${subject}` : 'Agent runtime',
        context: { turns: n, p95Ms: p95, p50Ms: numOrNull(row?.p50), thresholdMs: threshold },
      }),
    ];
  },
});
