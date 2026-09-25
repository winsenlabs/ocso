import type { AlertKind, TimeWindow } from '@ocso/alerts';
import { validation } from '@ocso/domain';
import type { DbOrTx } from '@ocso/db';
import type { QueueStats, Topic } from '@ocso/queue';
import { z } from 'zod';
import type { AlertRuleRow } from '../views.js';

/** One evaluated scope of a rule (a provider, an agent, a tool…). */
export interface Observation {
  /** fingerprint(ruleId, scope) — the deduplication key. */
  fingerprint: string;
  firing: boolean;
  /** Stable title (no live numbers), e.g. "Provider error rate above 5% · AWS Bedrock". */
  title: string;
  /** Measured vs threshold, window and volume — the explanation a human reads. */
  body: string;
  /** Compact measured value, e.g. "8.0%" or "p95 3.4s". */
  value: string;
  /** Human-readable origin shown in the "Source" column. */
  source: string;
  /** Correlation data: ids of providers/agents/conversations, raw counts, method. */
  context: Record<string, unknown>;
}

/** SQS mode has no jobs table; the worker passes the queue adapter's stats. */
export type QueueStatsFn = (topic: Topic) => Promise<QueueStats>;

export interface EvaluationContext<P> {
  db: DbOrTx;
  now: Date;
  window: TimeWindow;
  rule: AlertRuleRow;
  params: P;
  queueStats?: QueueStatsFn | undefined;
}

export interface EvaluatorDefinition<S extends z.ZodType<Record<string, unknown>>> {
  condition: string;
  label: string;
  kinds: readonly AlertKind[];
  /** Whether a rule for this condition may be bound to one virtual agent. */
  agentScoped: boolean;
  /** Plain-language method (docs/archive/specs/11 §3: explicit and auditable, no opaque scores). */
  method: string;
  params: S;
  evaluate(ctx: EvaluationContext<z.output<S>>): Promise<Observation[]>;
}

export type ParamsCheck = { ok: true; params: Record<string, unknown> } | { ok: false; problems: string[] };

/** Type-erased evaluator as held by the registry. */
export interface AlertEvaluator {
  readonly condition: string;
  readonly label: string;
  readonly kinds: readonly AlertKind[];
  readonly agentScoped: boolean;
  readonly method: string;
  parseParams(input: unknown): ParamsCheck;
  paramsJsonSchema(): Record<string, unknown>;
  run(ctx: Omit<EvaluationContext<unknown>, 'params'>): Promise<Observation[]>;
}

export function defineEvaluator<S extends z.ZodType<Record<string, unknown>>>(def: EvaluatorDefinition<S>): AlertEvaluator {
  const parseParams = (input: unknown): ParamsCheck => {
    const parsed = def.params.safeParse(input ?? {});
    if (parsed.success) return { ok: true, params: parsed.data };
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.map(String).join('.') || 'params'}: ${i.message}`) };
  };
  return {
    condition: def.condition,
    label: def.label,
    kinds: def.kinds,
    agentScoped: def.agentScoped,
    method: def.method,
    parseParams,
    paramsJsonSchema: () => z.toJSONSchema(def.params, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
    async run(ctx) {
      const parsed = def.params.safeParse(ctx.rule.params ?? {});
      if (!parsed.success) throw validation('invalid_alert_params', `rule ${ctx.rule.id} has invalid params for ${def.condition}`);
      return def.evaluate({ ...ctx, params: parsed.data });
    },
  };
}
