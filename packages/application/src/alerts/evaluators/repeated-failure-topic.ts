import { sql } from 'drizzle-orm';
import { formatCount } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { agentClause, at, num, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    minOccurrences: z.number().int().min(2).max(100_000).default(5),
  })
  .strict();

interface Row {
  agent_id: string;
  agent_name: string | null;
  topic_key: string;
  topic: string;
  n: number;
  samples: string[] | null;
}

export const repeatedFailureTopic = defineEvaluator({
  condition: 'repeated_failure_topic',
  label: 'Repeated failure topic',
  kinds: ['BUSINESS'],
  agentScoped: true,
  method:
    'conversation_insights rows generated in the window with a failureTopic (explicit classifier output, method version recorded per row), grouped per agent by case/whitespace-normalized topic. Fires for each topic seen at least `minOccurrences` times.',
  params: Params,
  async evaluate(ctx) {
    const rows = await queryRows<Row>(
      ctx.db,
      sql`SELECT i.agent_id::text AS agent_id, max(a.name) AS agent_name,
                 lower(regexp_replace(trim(i.failure_topic), '[[:space:]]+', ' ', 'g')) AS topic_key,
                 min(trim(i.failure_topic)) AS topic,
                 count(*)::int AS n,
                 (array_agg(i.conversation_id::text ORDER BY i.generated_at DESC))[1:10] AS samples
            FROM conversation_insights i
            LEFT JOIN virtual_agents a ON a.id = i.agent_id
           WHERE i.failure_topic IS NOT NULL AND trim(i.failure_topic) <> ''
             AND i.generated_at >= ${at(ctx.window.start)} AND i.generated_at <= ${at(ctx.now)}
             ${agentClause(sql`i.agent_id`, ctx.rule.agentId)}
           GROUP BY i.agent_id, 3
          HAVING count(*) >= ${ctx.params.minOccurrences}`,
    );
    return rows.map((r) => {
      const agent = r.agent_name ?? 'unknown agent';
      return observe(ctx, { agentId: r.agent_id, topic: r.topic_key }, {
        firing: true,
        agentId: r.agent_id,
        title: `Repeated failure topic · ${r.topic} · ${agent}`,
        value: `${formatCount(num(r.n))} conversations`,
        body: `"${r.topic}" was classified as the failure topic of ${formatCount(num(r.n))} conversation(s) with ${agent} ${windowPhrase(ctx)}; threshold ${formatCount(ctx.params.minOccurrences)}.`,
        source: `Agent · ${agent}`,
        context: { topic: r.topic, occurrences: num(r.n), minOccurrences: ctx.params.minOccurrences, sampleConversationIds: r.samples ?? [] },
      });
    });
  },
});
