import { sql } from 'drizzle-orm';
import { formatCount, formatDurationMs } from '@ocso/alerts';
import { TOPICS, type Topic } from '@ocso/queue';
import { z } from 'zod';
import { defineEvaluator, type EvaluationContext } from './contract.js';
import { at, num, numOrNull, observe, queryRows } from './support.js';

const TOPIC_VALUES = Object.values(TOPICS) as [Topic, ...Topic[]];

const Params = z
  .object({
    topic: z.enum(TOPIC_VALUES).default('conversation.turn'),
    thresholdSeconds: z.number().positive().max(86_400).default(30),
  })
  .strict();

async function oldestQueued(ctx: EvaluationContext<{ topic: Topic }>): Promise<{ depth: number; oldestSeconds: number | null }> {
  if (ctx.queueStats) {
    const stats = await ctx.queueStats(ctx.params.topic);
    return { depth: stats.depth, oldestSeconds: stats.oldestAgeSeconds };
  }
  const [row] = await queryRows<{ depth: number; oldest: number | null }>(
    ctx.db,
    sql`SELECT count(*)::int AS depth,
               extract(epoch FROM (${at(ctx.now)} - min(enqueued_at)))::float8 AS oldest
          FROM jobs
         WHERE topic = ${ctx.params.topic} AND status = 'queued' AND available_at <= ${at(ctx.now)}`,
  );
  return { depth: num(row?.depth), oldestSeconds: numOrNull(row?.oldest) };
}

export const queueAgeAbove = defineEvaluator({
  condition: 'queue_age_above',
  label: 'Queue age above threshold',
  kinds: ['TECHNICAL'],
  agentScoped: false,
  method:
    'Age of the oldest ready job (status queued, available now) on `topic`, from the database jobs table — or the queue driver\'s stats when messages live outside the database. Fires when the age exceeds `thresholdSeconds`.',
  params: Params,
  async evaluate(ctx) {
    const { depth, oldestSeconds } = await oldestQueued(ctx);
    const age = oldestSeconds ?? 0;
    const threshold = ctx.params.thresholdSeconds;
    return [
      observe(ctx, { topic: ctx.params.topic }, {
        firing: age > threshold,
        title: `Queue age above ${formatDurationMs(threshold * 1000)} · ${ctx.params.topic}`,
        value: formatDurationMs(age * 1000),
        body: `Oldest ready item on ${ctx.params.topic} has waited ${formatDurationMs(age * 1000)} against a ${formatDurationMs(threshold * 1000)} threshold; ${formatCount(depth)} item(s) ready.`,
        source: `Queue · ${ctx.params.topic}`,
        context: { topic: ctx.params.topic, depth, oldestAgeSeconds: oldestSeconds, thresholdSeconds: threshold, measuredFrom: ctx.queueStats ? 'queue_stats' : 'jobs_table' },
      }),
    ];
  },
});
