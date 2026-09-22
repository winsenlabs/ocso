import { and, asc, eq, lt } from 'drizzle-orm';
import { secretRequirement, type AlertDeliveryRegistry, type DeliveryResult } from '@ocso/alerts';
import { alertDeliveries, alerts, notificationDestinations, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { nowOf } from '../shared/context.js';
import { publishDeliveries } from './dispatch.js';
import { AlertDeliveryRetryableError } from './errors.js';
import { buildAlertMessage } from './message.js';

export interface AlertDeliveryOptions {
  db: Db;
  secrets: SecretStore;
  registry: AlertDeliveryRegistry;
  /** Public UI origin for deep links in external messages. */
  baseUrl?: string | null | undefined;
  /** Attempts before a transient failure becomes FAILED. Keep ≤ the queue's maxAttempts. */
  maxAttempts?: number | undefined;
  metrics?: { delivered?(labels: { kind: string; outcome: 'sent' | 'retry' | 'failed' }): void } | undefined;
  now?: (() => Date) | undefined;
}

export type DeliveryOutcome =
  | { status: 'SENT'; attempts: number }
  | { status: 'FAILED'; attempts: number; error: string }
  | { status: 'SKIPPED'; reason: 'missing' | 'already_sent' | 'already_failed' };

/**
 * Executes one alert_deliveries row for the worker's `alert.deliver` consumer.
 * Transient failures with attempts left throw AlertDeliveryRetryableError
 * (queue retries with backoff); everything else ends SENT or FAILED.
 */
export class AlertDeliveryService {
  private readonly maxAttempts: number;

  constructor(private readonly options: AlertDeliveryOptions) {
    this.maxAttempts = options.maxAttempts ?? 6;
  }

  async deliver(deliveryId: string): Promise<DeliveryOutcome> {
    const { db } = this.options;
    const [delivery] = await db.select().from(alertDeliveries).where(eq(alertDeliveries.id, deliveryId));
    if (!delivery) return { status: 'SKIPPED', reason: 'missing' };
    if (delivery.status === 'SENT') return { status: 'SKIPPED', reason: 'already_sent' };
    if (delivery.status === 'FAILED') return { status: 'SKIPPED', reason: 'already_failed' };
    const attempts = delivery.attempts + 1;

    const [alert] = await db.select().from(alerts).where(eq(alerts.id, delivery.alertId));
    const [destination] = await db.select().from(notificationDestinations).where(eq(notificationDestinations.id, delivery.destinationId));
    if (!alert) return this.fail(deliveryId, attempts, 'alert no longer exists', 'unknown');
    if (!destination || !destination.enabled) return this.fail(deliveryId, attempts, 'destination removed or disabled', destination?.kind ?? 'unknown');
    const adapter = this.options.registry.find(destination.kind);
    if (!adapter) return this.fail(deliveryId, attempts, `no adapter for ${destination.kind}`, destination.kind);
    const config = adapter.validateConfig(destination.config);
    if (!config.ok) return this.fail(deliveryId, attempts, `invalid configuration: ${config.problems.join('; ')}`, destination.kind);

    let result: DeliveryResult;
    try {
      const requirement = secretRequirement(adapter, config.config);
      const secret = destination.secretRef && requirement ? await this.options.secrets.resolve(destination.secretRef) : null;
      if (requirement?.required && !secret) return this.fail(deliveryId, attempts, 'secret not configured', destination.kind);
      const message = await buildAlertMessage(db, alert, { id: delivery.id, event: delivery.event }, { baseUrl: this.options.baseUrl });
      result = await adapter.deliver(message, config.config, secret);
    } catch {
      // Unexpected adapter/secret-store exception: treat as transient, never echo its text.
      result = { ok: false, retriable: true, error: 'delivery error' };
    }

    if (result.ok) {
      await db
        .update(alertDeliveries)
        .set({ status: 'SENT', attempts, lastError: null, sentAt: nowOf(this.options) })
        .where(eq(alertDeliveries.id, deliveryId));
      this.options.metrics?.delivered?.({ kind: destination.kind, outcome: 'sent' });
      return { status: 'SENT', attempts };
    }
    const error = result.error ?? 'delivery failed';
    if (result.retriable && attempts < this.maxAttempts) {
      await db.update(alertDeliveries).set({ attempts, lastError: error }).where(eq(alertDeliveries.id, deliveryId));
      this.options.metrics?.delivered?.({ kind: destination.kind, outcome: 'retry' });
      throw new AlertDeliveryRetryableError(deliveryId, attempts, error);
    }
    return this.fail(deliveryId, attempts, error, destination.kind);
  }

  /**
   * Re-publish PENDING deliveries older than `olderThanSeconds` (lost publish
   * after commit, driver outage). The per-delivery dedupe key makes this safe
   * while a job is still queued or running.
   */
  async redispatchPending(queue: QueueAdapter, olderThanSeconds = 300, limit = 200): Promise<number> {
    const cutoff = new Date(nowOf(this.options).getTime() - olderThanSeconds * 1000);
    const rows = await this.options.db
      .select({ id: alertDeliveries.id, alertId: alertDeliveries.alertId })
      .from(alertDeliveries)
      .where(and(eq(alertDeliveries.status, 'PENDING'), lt(alertDeliveries.createdAt, cutoff)))
      .orderBy(asc(alertDeliveries.createdAt))
      .limit(limit);
    const failures = await publishDeliveries(queue, rows);
    return rows.length - failures;
  }

  private async fail(deliveryId: string, attempts: number, error: string, kind: string): Promise<DeliveryOutcome> {
    await this.options.db
      .update(alertDeliveries)
      .set({ status: 'FAILED', attempts, lastError: error.slice(0, 500) })
      .where(eq(alertDeliveries.id, deliveryId));
    this.options.metrics?.delivered?.({ kind, outcome: 'failed' });
    return { status: 'FAILED', attempts, error };
  }
}
