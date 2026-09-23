import { sql } from 'drizzle-orm';
import { formatCount } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    /** Fires when breaches > threshold (0 = any breach). */
    threshold: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

interface Row {
  agent_id: string;
  agent_name: string;
  open_breaches: number;
  missed: number;
  samples: string[] | null;
}

export const resolutionSlaBreachesAbove = defineEvaluator({
  condition: 'resolution_sla_breaches_above',
  label: 'Resolution SLA breaches',
  kinds: ['BUSINESS'],
  agentScoped: true,
  method:
    'Per virtual agent: open breaches = unresolved conversations whose resolutionDueAt (queue SLA policy × conversation type, from opening or reopening) has passed; missed = conversations resolved in the window after their resolutionDueAt. Fires when open breaches + missed > `threshold`.',
  params: Params,
  async evaluate(ctx) {
    const now = at(ctx.now);
    const rows = await queryRows<Row>(
      ctx.db,
      sql`WITH breached AS (
            SELECT c.id, c.agent_id,
                   (c.control_state <> 'RESOLVED' AND c.resolution_due_at < ${now}) AS open_breach,
                   (c.control_state = 'RESOLVED' AND c.resolved_at >= ${at(ctx.window.start)} AND c.resolved_at <= ${now}
                      AND c.resolved_at > c.resolution_due_at) AS missed
              FROM conversations c
             WHERE c.resolution_due_at IS NOT NULL AND c.resolution_due_at < ${now}
               ${agentClause(sql`c.agent_id`, ctx.rule.agentId)}
          )
          SELECT b.agent_id::text AS agent_id, a.name AS agent_name,
                 count(*) FILTER (WHERE b.open_breach)::int AS open_breaches,
                 count(*) FILTER (WHERE b.missed)::int AS missed,
                 (array_agg(b.id::text ORDER BY b.id) FILTER (WHERE b.open_breach OR b.missed))[1:10] AS samples
            FROM breached b JOIN virtual_agents a ON a.id = b.agent_id
           WHERE b.open_breach OR b.missed
           GROUP BY b.agent_id, a.name`,
    );
    return rows.map((r) => {
      const open = num(r.open_breaches);
      const missed = num(r.missed);
      const total = open + missed;
      return observe(ctx, { agentId: r.agent_id }, {
        firing: total > ctx.params.threshold,
        agentId: r.agent_id,
        title: `Resolution SLA breaches · ${r.agent_name}`,
        value: formatCount(total),
        body: `${formatCount(open)} open conversation(s) with ${r.agent_name} are past their resolution target, and ${formatCount(missed)} were resolved late ${windowPhrase(ctx)}; threshold ${formatCount(ctx.params.threshold)}.`,
        source: `Agent · ${r.agent_name}`,
        context: { openBreaches: open, resolvedLateInWindow: missed, threshold: ctx.params.threshold, sampleConversationIds: r.samples ?? [] },
      });
    });
  },
});
