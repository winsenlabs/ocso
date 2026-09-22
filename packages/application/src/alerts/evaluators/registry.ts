import type { AlertEvaluator } from './contract.js';
import { authFailuresAbove } from './auth-failures-above.js';
import { conversionDrop } from './conversion-drop.js';
import { costSpike } from './cost-spike.js';
import { csatBelow } from './csat-below.js';
import { databaseDegraded } from './database-degraded.js';
import { escalationRateAbove } from './escalation-rate-above.js';
import { latencyP95Above } from './latency-p95-above.js';
import { mcpUnhealthy } from './mcp-unhealthy.js';
import { providerErrorRateAbove } from './provider-error-rate-above.js';
import { queueAgeAbove } from './queue-age-above.js';
import { repeatedFailureTopic } from './repeated-failure-topic.js';
import { slaBreachesAbove } from './sla-breaches-above.js';
import { resolutionSlaBreachesAbove } from './resolution-sla-breaches-above.js';
import { tokenSpike } from './token-spike.js';
import { toolFailureRateAbove } from './tool-failure-rate-above.js';
import { ttftP95Above } from './ttft-p95-above.js';
import { workersBelowMin } from './workers-below-min.js';

/** Rule conditions are registered evaluators, never a switch (build rule §2/§4). */
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, AlertEvaluator>();

  register(evaluator: AlertEvaluator): this {
    if (this.evaluators.has(evaluator.condition)) throw new Error(`alert evaluator ${evaluator.condition} already registered`);
    this.evaluators.set(evaluator.condition, evaluator);
    return this;
  }

  find(condition: string): AlertEvaluator | undefined {
    return this.evaluators.get(condition);
  }

  list(): AlertEvaluator[] {
    return [...this.evaluators.values()];
  }
}

export const BUILT_IN_EVALUATORS: readonly AlertEvaluator[] = [
  // Technical
  workersBelowMin,
  queueAgeAbove,
  providerErrorRateAbove,
  latencyP95Above,
  ttftP95Above,
  mcpUnhealthy,
  tokenSpike,
  costSpike,
  authFailuresAbove,
  databaseDegraded,
  // Business
  escalationRateAbove,
  slaBreachesAbove,
  resolutionSlaBreachesAbove,
  repeatedFailureTopic,
  toolFailureRateAbove,
  csatBelow,
  conversionDrop,
];

export function createDefaultEvaluatorRegistry(): EvaluatorRegistry {
  const registry = new EvaluatorRegistry();
  for (const evaluator of BUILT_IN_EVALUATORS) registry.register(evaluator);
  return registry;
}
