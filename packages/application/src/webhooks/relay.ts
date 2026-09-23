import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { outboxEvents, uuidv7, webhookDeliveries, webhookSubscriptions, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { matchesAny } from './event-types.js';

const BATCH = 500;
const MAX_BATCHES_PER_RUN = 10;

/**
 * Outbox → webhook deliveries (leader scheduler task). Each outbox event is
 * fanned out to matching enabled subscriptions created before it occurred,
 * then marked published. Delivery rows are unique per (subscription, event),
 * so a re-run after a crash never duplicates. At-least-once; unordered.
 */
export async function relayOutboxToWebhooks(db: Db, queue: QueueAdapter): Promise<number> {
  let queued = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const { created, scanned } = await relayBatch(db);
    for (const id of created) await queue.publish('webhook.deliver', { deliveryId: id }, { dedupeKey: `webhook:${id}` });
    queued += created.length;
    if (scanned < BATCH) break;
  }
  return queued + (await redispatchStale(db, queue));
}

async function relayBatch(db: Db): Promise<{ created: string[]; scanned: number }> {
  return db.transaction(async (tx) => {
    const events = await tx
      .select({ id: outboxEvents.id, type: outboxEvents.type, occurredAt: outboxEvents.occurredAt })
      .from(outboxEvents)
      .where(sql`${outboxEvents.publishedAt} IS NULL`)
      .orderBy(outboxEvents.occurredAt)
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (!events.length) return { created: [], scanned: 0 };
    const subs = await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.enabled, true));
    const rows = events.flatMap((e) =>
      subs.filter((s) => e.occurredAt >= s.createdAt && matchesAny(s.events, e.type)).map((s) => ({ id: uuidv7(), subscriptionId: s.id, eventId: e.id, eventType: e.type })),
    );
    const created = rows.length ? await tx.insert(webhookDeliveries).values(rows).onConflictDoNothing().returning({ id: webhookDeliveries.id }) : [];
    await tx.update(outboxEvents).set({ publishedAt: new Date() }).where(inArray(outboxEvents.id, events.map((e) => e.id)));
    return { created: created.map((c) => c.id), scanned: events.length };
  });
}

/** Deliveries created but never picked up (crash between commit and publish). */
async function redispatchStale(db: Db, queue: QueueAdapter): Promise<number> {
  const stale = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'PENDING'), eq(webhookDeliveries.attempts, 0), lt(webhookDeliveries.createdAt, new Date(Date.now() - 5 * 60_000))))
    .limit(200);
  for (const row of stale) await queue.publish('webhook.deliver', { deliveryId: row.id }, { dedupeKey: `webhook:${row.id}` });
  return stale.length;
}
