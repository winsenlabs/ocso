import { and, eq, inArray } from 'drizzle-orm';
import type { AlertEvent, DestinationEventRouting } from '@ocso/alerts';
import { alertDeliveries, notificationDestinations, uuidv7, type DbOrTx } from '@ocso/db';
import { TOPICS, type QueueAdapter } from '@ocso/queue';

/** Payload of an `alert.deliver` job. The job is a signal; the row is the truth. */
export interface AlertDeliverJob {
  deliveryId: string;
}

export interface PendingDelivery {
  id: string;
  alertId: string;
}

/**
 * Create PENDING alert_deliveries rows for every enabled destination of the
 * rule whose adapter receives `event` (the registry decides; destinations of
 * an unregistered kind receive nothing). Call inside the transaction that
 * changed the alert; publish the jobs after commit with `publishDeliveries`.
 */
export async function createDeliveries(
  tx: DbOrTx,
  routing: DestinationEventRouting,
  alertId: string,
  destinationIds: readonly string[],
  event: AlertEvent,
  now: Date,
): Promise<PendingDelivery[]> {
  if (!destinationIds.length) return [];
  const destinations = await tx
    .select({ id: notificationDestinations.id, kind: notificationDestinations.kind })
    .from(notificationDestinations)
    .where(and(inArray(notificationDestinations.id, [...new Set(destinationIds)]), eq(notificationDestinations.enabled, true)));
  const targets = destinations.filter((d) => routing.receives(d.kind, event));
  if (!targets.length) return [];
  const rows = targets.map((d) => ({ id: uuidv7(), alertId, destinationId: d.id, event, status: 'PENDING' as const, createdAt: now }));
  await tx.insert(alertDeliveries).values(rows);
  return rows.map((r) => ({ id: r.id, alertId }));
}

/**
 * Enqueue one `alert.deliver` job per delivery (after commit). Failures are
 * counted, not thrown: PENDING rows are re-published by the stale sweep.
 */
export async function publishDeliveries(queue: QueueAdapter, deliveries: readonly PendingDelivery[]): Promise<number> {
  const results = await Promise.allSettled(
    deliveries.map((d) =>
      queue.publish<AlertDeliverJob>(TOPICS.ALERT_DELIVER, { deliveryId: d.id }, { dedupeKey: `alert-delivery:${d.id}`, groupKey: d.alertId }),
    ),
  );
  return results.filter((r) => r.status === 'rejected').length;
}
