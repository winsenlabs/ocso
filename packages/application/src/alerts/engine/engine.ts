import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { evaluationWindow, type AlertKind, type AlertSeverity, type DestinationEventRouting } from '@ocso/alerts';
import { alertRules, uuidv7, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { systemActor } from '../../shared/context.js';
import { publishDeliveries, type PendingDelivery } from '../dispatch.js';
import type { QueueStatsFn } from '../evaluators/contract.js';
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from '../evaluators/registry.js';
import type { AlertRuleRow } from '../views.js';
import { applyObservations } from './apply.js';

/** Low-cardinality metric hooks (kind, severity, condition — never ids). */
export interface AlertEngineMetrics {
  alertOpened?(labels: { kind: AlertKind; severity: AlertSeverity; condition: string }): void;
  alertsResolved?(labels: { condition: string }, count: number): void;
  evaluationFailed?(labels: { condition: string }): void;
}

export interface AlertEngineOptions {
  db: Db;
  queue: QueueAdapter;
  /** The alert delivery registry: which destination kinds receive which lifecycle events. */
  destinations: DestinationEventRouting;
  evaluators?: EvaluatorRegistry | undefined;
  /** SQS mode: queue driver stats for queue_age_above (Postgres mode reads the jobs table). */
  queueStats?: QueueStatsFn | undefined;
  metrics?: AlertEngineMetrics | undefined;
  now?: (() => Date) | undefined;
}

export interface EvaluateOptions {
  /** Restrict to these rules (manual "evaluate now", tests). Disabled rules are still skipped. */
  ruleIds?: readonly string[] | undefined;
}

export interface EvaluationSummary {
  evaluatedAt: string;
  rules: number;
  opened: number;
  updated: number;
  resolved: number;
  suppressed: number;
  deliveriesQueued: number;
  publishFailures: number;
  failed: Array<{ ruleId: string; condition: string; error: string }>;
}

/**
 * Periodic rule evaluation (PM/BUILD-PLAN E8.8). The worker's leader-elected
 * scheduler calls `evaluate()`; each rule is evaluated and applied in its own
 * transaction so one broken rule never blocks the others.
 */
export class AlertEngine {
  private readonly evaluators: EvaluatorRegistry;

  constructor(private readonly options: AlertEngineOptions) {
    this.evaluators = options.evaluators ?? createDefaultEvaluatorRegistry();
  }

  async evaluate(now: Date = this.options.now?.() ?? new Date(), options: EvaluateOptions = {}): Promise<EvaluationSummary> {
    const { db, queue, metrics } = this.options;
    const actor = systemActor('alert-engine', `alert-eval:${uuidv7()}`, 'Alert engine');
    const where: SQL[] = [eq(alertRules.enabled, true)];
    if (options.ruleIds) where.push(inArray(alertRules.id, [...options.ruleIds]));
    const rules = options.ruleIds?.length === 0 ? [] : await db.select().from(alertRules).where(and(...where)).orderBy(asc(alertRules.createdAt));

    const summary: EvaluationSummary = {
      evaluatedAt: now.toISOString(),
      rules: rules.length,
      opened: 0,
      updated: 0,
      resolved: 0,
      suppressed: 0,
      deliveriesQueued: 0,
      publishFailures: 0,
      failed: [],
    };
    const pending: PendingDelivery[] = [];
    for (const rule of rules) {
      try {
        const outcome = await this.evaluateRule(rule, now, actor);
        summary.opened += outcome.opened.length;
        summary.updated += outcome.updated;
        summary.resolved += outcome.resolved;
        summary.suppressed += outcome.suppressed;
        pending.push(...outcome.deliveries);
        for (const o of outcome.opened) metrics?.alertOpened?.({ kind: o.kind, severity: o.severity, condition: rule.condition });
        if (outcome.resolved) metrics?.alertsResolved?.({ condition: rule.condition }, outcome.resolved);
      } catch (error) {
        summary.failed.push({ ruleId: rule.id, condition: rule.condition, error: errorText(error) });
        metrics?.evaluationFailed?.({ condition: rule.condition });
      }
    }
    summary.publishFailures = await publishDeliveries(queue, pending);
    summary.deliveriesQueued = pending.length - summary.publishFailures;
    return summary;
  }

  private async evaluateRule(rule: AlertRuleRow, now: Date, actor: ReturnType<typeof systemActor>) {
    const evaluator = this.evaluators.find(rule.condition);
    if (!evaluator) throw new Error(`unknown condition ${rule.condition}`);
    const observations = await evaluator.run({
      db: this.options.db,
      now,
      window: evaluationWindow(now, rule.windowSeconds),
      rule,
      queueStats: this.options.queueStats,
    });
    return this.options.db.transaction((tx) => applyObservations(tx, actor, rule, evaluator, observations, now, this.options.destinations));
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'unknown error';
  return text.slice(0, 300);
}
