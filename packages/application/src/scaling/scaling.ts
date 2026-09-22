import { isDomainError } from '@ocso/domain';
import { workerScalingState, type Db } from '@ocso/db';
import { silentLogger, type DeploymentAdapter, type DeploymentLogger, type DeploymentStatus, type ScalingApplyResult, type ScalingSettings } from '@ocso/deployment';
import type { QueueAdapter } from '@ocso/queue';
import { SettingsService, type WorkerSettings } from '../settings/settings.js';
import { computeScalingSample, type ScalingSampleDetail } from './sample.js';

export type ScalingTrigger = 'startup' | 'periodic' | 'config_changed';

export interface ScalingServiceDeps {
  db: Db;
  adapter: DeploymentAdapter;
  queue: Pick<QueueAdapter, 'stats' | 'reportsOldestAge'>;
  logger?: DeploymentLogger | undefined;
  now?: (() => Date) | undefined;
}

export interface ScalingReconcileOutcome {
  status: 'APPLIED' | 'ADVISORY' | 'FAILED';
  message: string;
  result: ScalingApplyResult | null;
  deployment: DeploymentStatus | null;
  describeError: string | null;
  /** worker_settings.updated_at this attempt applied. */
  settingsUpdatedAt: Date;
}

export function toScalingSettings(s: WorkerSettings): ScalingSettings {
  return {
    autoscalingEnabled: s.autoscalingEnabled,
    minWarmWorkers: s.minWarmWorkers,
    maxWorkers: s.maxWorkers,
    conversationsPerWorker: s.conversationsPerWorker,
    targetUtilization: s.targetUtilization,
    scaleOutQueueAgeSeconds: s.scaleOutQueueAgeSeconds,
    scaleOutQueueDepth: s.scaleOutQueueDepth,
    scaleInCooldownSeconds: s.scaleInCooldownSeconds,
  };
}

/**
 * Applies worker settings through the deployment adapter and records the
 * outcome durably (ADR-023). Runs on the worker scheduler leader only — the
 * worker is the one process with the platform's scaling permissions; the API
 * reads the recorded outcome (ScalingStatusService).
 */
export class ScalingService {
  private tail: Promise<unknown> = Promise.resolve();
  private queued: Promise<ScalingReconcileOutcome> | null = null;
  private readonly logger: DeploymentLogger;

  constructor(private readonly deps: ScalingServiceDeps) {
    this.logger = deps.logger ?? silentLogger;
  }

  get driver(): DeploymentAdapter['driver'] {
    return this.deps.adapter.driver;
  }

  get publishesMetrics(): boolean {
    return this.deps.adapter.publishesMetrics;
  }

  /**
   * Apply the current settings and refresh the deployment snapshot. Runs are
   * serialized; requests arriving while one waits share it (it reads the
   * settings when it starts, so it sees the newest change).
   */
  reconcile(trigger: ScalingTrigger): Promise<ScalingReconcileOutcome> {
    if (this.queued) return this.queued;
    const run = this.tail.then(() => {
      this.queued = null;
      return this.runOnce(trigger);
    });
    this.queued = run;
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Sample from PostgreSQL and publish; null when the adapter has no metrics sink. */
  async publishMetrics(): Promise<ScalingSampleDetail | null> {
    if (!this.deps.adapter.publishesMetrics) return null;
    const sample = await computeScalingSample(this.deps.db, this.deps.queue, this.now());
    await this.deps.adapter.publishMetrics(sample);
    return sample;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private async runOnce(trigger: ScalingTrigger): Promise<ScalingReconcileOutcome> {
    const { db, adapter } = this.deps;
    const settings = await new SettingsService(db).workers();
    let result: ScalingApplyResult | null = null;
    let status: ScalingReconcileOutcome['status'];
    let message: string;
    let detail: Record<string, unknown>;
    try {
      result = await adapter.applyScaling(toScalingSettings(settings));
      ({ outcome: status, message } = result);
      detail = { ...result };
      if (result.changes.length) this.logger.info({ trigger, driver: adapter.driver, changes: result.changes }, 'worker scaling applied');
    } catch (err) {
      status = 'FAILED';
      message = errorText(err);
      detail = isDomainError(err) ? { code: err.code, category: err.category, ...err.details } : { code: 'unexpected' };
      this.logger.warn({ trigger, driver: adapter.driver, reason: message }, 'worker scaling apply failed');
    }

    let deployment: DeploymentStatus | null = null;
    let describeError: string | null = null;
    try {
      deployment = await adapter.describe();
    } catch (err) {
      describeError = errorText(err);
      this.logger.warn({ driver: adapter.driver, reason: describeError }, 'deployment describe failed');
    }

    const attemptedAt = this.now();
    const row = {
      driver: adapter.driver,
      applyStatus: status,
      applyMessage: message,
      applyDetail: detail,
      attemptedAt,
      settingsUpdatedAt: settings.updatedAt,
      describeError,
      updatedAt: attemptedAt,
      ...(status === 'FAILED' ? {} : { lastSucceededAt: attemptedAt }),
      // A failed describe keeps the previous snapshot (describeError says why it is old).
      ...(deployment ? { deployment: { ...deployment }, describedAt: attemptedAt } : {}),
    };
    await db
      .insert(workerScalingState)
      .values({ id: 1, ...row })
      .onConflictDoUpdate({ target: workerScalingState.id, set: row });
    return { status, message, result, deployment, describeError, settingsUpdatedAt: settings.updatedAt };
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 500);
}
