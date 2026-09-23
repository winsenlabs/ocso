import { sql } from 'drizzle-orm';
import { formatCount, formatPercent } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    thresholdPercent: z.number().gt(0).max(100).default(25),
    minConversations: z.number().int().min(1).max(1_000_000).default(20),
  })
  .strict();

interface Row {
  agent_id: string;
  agent_name: string;
  conversations: number;
  escalated: number;
  reasons: Record<string, number> | null;
  samples: string[] | null;
}

export const escalationRateAbove = defineEvaluator({
  condition: 'escalation_rate_above',
  label: 'Escalation rate above threshold',
  kinds: ['BUSINESS'],
  agentScoped: true,
  method:
    'Cohort per virtual agent: conversations opened in the window. Escalated = the conversation has at least one handoff request (up to evaluation time). Rate = escalated / cohort size. Agents with fewer than `minConversations` conversations are not judged. Fires when rate > `thresholdPercent`.',
  params: Params,
  async evaluate(ctx) {
    const rows = await queryRows<Row>(
      ctx.db,
      sql`WITH cohort AS (
            SELECT c.id, c.agent_id,
                   EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id AND h.requested_at <= ${at(ctx.now)}) AS escalated
              FROM conversations c
             WHERE c.opened_at >= ${at(ctx.window.start)} AND c.opened_at <= ${at(ctx.now)}
               ${agentClause(sql`c.agent_id`, ctx.rule.agentId)}
          )
          SELECT k.agent_id::text AS agent_id, a.name AS agent_name,
                 count(*)::int AS conversations,
                 count(*) FILTER (WHERE k.escalated)::int AS escalated,
                 (SELECT jsonb_object_agg(reason_code, n) FROM (
                    SELECT h.reason_code, count(*)::int AS n FROM handoffs h JOIN cohort x ON x.id = h.conversation_id
                     WHERE x.agent_id = k.agent_id AND h.requested_at <= ${at(ctx.now)}
                     GROUP BY h.reason_code ORDER BY 2 DESC LIMIT 5) r) AS reasons,
                 (array_agg(k.id::text ORDER BY k.id) FILTER (WHERE k.escalated))[1:10] AS samples
            FROM cohort k JOIN virtual_agents a ON a.id = k.agent_id
           GROUP BY k.agent_id, a.name`,
    );
    const threshold = ctx.params.thresholdPercent / 100;
    return rows.map((r) => {
      const total = num(r.conversations);
      const escalated = num(r.escalated);
      const rate = total ? escalated / total : 0;
      return observe(ctx, { agentId: r.agent_id }, {
        firing: total >= ctx.params.minConversations && rate > threshold,
        agentId: r.agent_id,
        title: `Escalation rate above ${formatPercent(threshold)} · ${r.agent_name}`,
        value: formatPercent(rate),
        body: `${formatCount(escalated)} of ${formatCount(total)} conversations opened ${windowPhrase(ctx)} with ${r.agent_name} were escalated to a human (${formatPercent(rate)}); threshold ${formatPercent(threshold)}, minimum volume ${formatCount(ctx.params.minConversations)}.`,
        source: `Agent · ${r.agent_name}`,
        context: { conversations: total, escalated, rate, thresholdPercent: ctx.params.thresholdPercent, reasons: r.reasons ?? {}, sampleConversationIds: r.samples ?? [] },
      });
    });
  },
});
