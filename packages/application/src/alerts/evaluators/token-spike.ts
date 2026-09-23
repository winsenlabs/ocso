import { sql } from 'drizzle-orm';
import { formatCount } from '@ocso/alerts';
import { defineEvaluator } from './contract.js';
import { evaluateSpike, spikeParams } from './spike.js';

export const tokenSpike = defineEvaluator({
  condition: 'token_spike',
  label: 'Token usage spike',
  kinds: ['TECHNICAL'],
  agentScoped: true,
  method:
    'Sum of usage_events input_tokens + output_tokens in the window vs the average per-window sum over the previous `baselineWindows` windows. Fires when the window total is at least `ratio` × baseline and at least `minValue` tokens. No baseline → not judged.',
  params: spikeParams(50_000),
  evaluate: (ctx) =>
    evaluateSpike(ctx, {
      expression: sql`(input_tokens + output_tokens)`,
      noun: 'tokens',
      format: formatCount,
      title: 'Token usage spike',
      source: 'Model usage · tokens',
    }),
});
