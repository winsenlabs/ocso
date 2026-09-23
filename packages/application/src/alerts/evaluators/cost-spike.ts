import { sql } from 'drizzle-orm';
import { formatMicros } from '@ocso/alerts';
import { defineEvaluator } from './contract.js';
import { evaluateSpike, spikeParams } from './spike.js';

export const costSpike = defineEvaluator({
  condition: 'cost_spike',
  label: 'Model cost spike',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'Sum of usage_events cost_micros (price-table metadata, micro-units) in the window vs the average per-window sum over the previous `baselineWindows` windows. Fires when the window total is at least `ratio` × baseline and at least `minValue` micros. No baseline → not judged.',
  params: spikeParams(1_000_000),
  evaluate: (ctx) =>
    evaluateSpike(ctx, {
      expression: sql`coalesce(cost_micros, 0)`,
      noun: 'model cost',
      format: (micros) => formatMicros(micros),
      title: 'Model cost spike',
      source: 'Model usage · cost',
    }),
});
