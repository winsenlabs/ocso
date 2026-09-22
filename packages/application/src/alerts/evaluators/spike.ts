import { sql, type SQL } from 'drizzle-orm';
import { baselineWindow, formatMultiplier, formatWindow } from '@ocso/alerts';
import { z } from 'zod';
import type { EvaluationContext, Observation } from './contract.js';
import { agentClause, at, num, observe, queryRows } from './support.js';

/** Params shared by window-vs-trailing-baseline spike evaluators. */
export const spikeParams = (minValueDefault: number) =>
  z
    .object({
      /** Fires when window total ≥ ratio × average baseline window total. */
      ratio: z.number().gt(1).max(1000).default(3),
      /** Number of equal-length windows immediately before the evaluation window. */
      baselineWindows: z.number().int().min(1).max(168).default(12),
      /** Ignore spikes below this absolute window total (noise floor). */
      minValue: z.number().min(0).default(minValueDefault),
    })
    .strict();

export type SpikeParams = z.output<ReturnType<typeof spikeParams>>;

export interface SpikeMeasure {
  /** Trusted SQL expression summed over usage_events rows (never user input). */
  expression: SQL;
  noun: string;
  format: (value: number) => string;
  title: string;
  source: string;
}

/**
 * Window total vs trailing baseline over usage_events. Baseline average =
 * baseline total / baselineWindows. No baseline (average 0) → not judged,
 * because a ratio against nothing is not meaningful.
 */
export async function evaluateSpike(ctx: EvaluationContext<SpikeParams>, measure: SpikeMeasure): Promise<Observation[]> {
  const baseline = baselineWindow(ctx.now, ctx.rule.windowSeconds, ctx.params.baselineWindows);
  const [row] = await queryRows<{ current: number; baseline_total: number; agent_name: string | null }>(
    ctx.db,
    sql`SELECT coalesce(sum(${measure.expression}) FILTER (WHERE occurred_at >= ${at(ctx.window.start)}), 0)::float8 AS current,
               coalesce(sum(${measure.expression}) FILTER (WHERE occurred_at < ${at(ctx.window.start)}), 0)::float8 AS baseline_total,
               (SELECT name FROM virtual_agents WHERE id = ${ctx.rule.agentId}::uuid) AS agent_name
          FROM usage_events
         WHERE occurred_at >= ${at(baseline.start)} AND occurred_at <= ${at(ctx.now)}
           ${agentClause(sql`agent_id`, ctx.rule.agentId)}`,
  );
  const current = num(row?.current);
  const baselineAvg = num(row?.baseline_total) / ctx.params.baselineWindows;
  const ratio = baselineAvg > 0 ? current / baselineAvg : null;
  const subject = row?.agent_name ?? 'all agents';
  const firing = ratio !== null && current >= ctx.params.minValue && ratio >= ctx.params.ratio;
  const span = formatWindow(ctx.rule.windowSeconds);
  return [
    observe(ctx, { agentId: ctx.rule.agentId }, {
      firing,
      title: `${measure.title} · ${subject}`,
      value: ratio === null ? measure.format(current) : `${formatMultiplier(ratio)} baseline`,
      body:
        `${measure.format(current)} ${measure.noun} in the last ${span} for ${subject} vs an average of ${measure.format(baselineAvg)} per ${span} over the previous ${ctx.params.baselineWindows} window(s)` +
        `${ratio === null ? ' (no baseline yet)' : ` (${formatMultiplier(ratio)})`}; fires at ${formatMultiplier(ctx.params.ratio)} and at least ${measure.format(ctx.params.minValue)}.`,
      source: measure.source,
      context: {
        current,
        baselineAverage: baselineAvg,
        observedRatio: ratio,
        baselineStart: baseline.start.toISOString(),
        thresholdRatio: ctx.params.ratio,
        baselineWindows: ctx.params.baselineWindows,
        minValue: ctx.params.minValue,
      },
    }),
  ];
}
