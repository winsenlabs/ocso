import { eq } from 'drizzle-orm';
import { isRetriableStatus, postJson, signatureHeader, type FetchFn } from '@ocso/alerts';
import { outboxEvents, webhookDeliveries, webhookSubscriptions, type Db } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { conversationRef, type WebhookEnvelope } from './envelope.js';
import { WEBHOOK_TEST_EVENT } from './event-types.js';

export class WebhookRetryableError extends Error {
  constructor(readonly deliveryId: string, readonly attempts: number) {
    super(`webhook delivery ${deliveryId} will be retried (attempt ${attempts})`);
  }
}
export const isWebhookRetryable = (e: unknown): e is WebhookRetryableError => e instanceof WebhookRetryableError;

export interface WebhookDeliveryOptions {
  db: Db;
  secrets: SecretStore;
  /** SSRF-guarded fetch (public https only). */
  fetch: FetchFn;
  maxAttempts?: number | undefined;
  timeoutMs?: number | undefined;
}

type Outcome = { ok: true; status: number } | { ok: false; retriable: boolean; error: string; status: number | null };

/**
 * Signed delivery of one webhook_deliveries row (`X-OCSO-Signature:
 * t=<ts>,v1=<HMAC-SHA256(secret, "<ts>.<body>")>`, the same scheme as alert
 * webhooks). Receivers dedupe on the envelope `id` (event id).
 */
export class WebhookDeliveryService {
  constructor(private readonly options: WebhookDeliveryOptions) {}

  async deliver(deliveryId: string): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    const { db } = this.options;
    const [row] = await db
      .select({ d: webhookDeliveries, s: webhookSubscriptions })
      .from(webhookDeliveries)
      .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
      .where(eq(webhookDeliveries.id, deliveryId));
    if (!row || row.d.status !== 'PENDING') return 'SKIPPED';
    const attempts = row.d.attempts + 1;
    if (!row.s.enabled) return this.finish(deliveryId, attempts, { ok: false, retriable: false, error: 'subscription disabled', status: null });
    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, row.d.eventId));
    if (!event) return this.finish(deliveryId, attempts, { ok: false, retriable: false, error: 'event no longer retained', status: null });
    const envelope: WebhookEnvelope = {
      id: event.id,
      type: event.type,
      version: event.version,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
      agentId: event.agentId,
      conversation: await conversationRef(db, event.conversationId),
      data: event.payload,
    };
    const outcome = await this.send(row.s.url, row.s.signingSecretRef, envelope, deliveryId);
    const final = !outcome.ok && outcome.retriable && attempts < (this.options.maxAttempts ?? 8) ? null : outcome;
    if (!final) {
      await db.update(webhookDeliveries).set({ attempts, lastError: outcome.ok ? null : outcome.error, responseStatus: outcome.status }).where(eq(webhookDeliveries.id, deliveryId));
      throw new WebhookRetryableError(deliveryId, attempts);
    }
    return this.finish(deliveryId, attempts, final);
  }

  /** "Send test" from the admin UI: synchronous, not recorded as a delivery. */
  async sendTest(subscriptionId: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const [sub] = await this.options.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
    if (!sub) return { ok: false, status: null, error: 'subscription not found' };
    const envelope: WebhookEnvelope = { id: crypto.randomUUID(), type: WEBHOOK_TEST_EVENT, version: 1, occurredAt: new Date().toISOString(), correlationId: 'webhook-test', agentId: null, conversation: null, data: { message: 'Test delivery from OCSO' } };
    const outcome = await this.send(sub.url, sub.signingSecretRef, envelope, `test-${envelope.id}`);
    return outcome.ok ? { ok: true, status: outcome.status, error: null } : { ok: false, status: outcome.status, error: outcome.error };
  }

  private async send(url: string, secretRef: string, envelope: WebhookEnvelope, deliveryId: string): Promise<Outcome> {
    const body = JSON.stringify(envelope);
    let secret: string;
    try {
      secret = await this.options.secrets.resolve(secretRef);
    } catch {
      return { ok: false, retriable: true, error: 'signing secret unavailable', status: null };
    }
    const result = await postJson(this.options.fetch, {
      url,
      body,
      timeoutMs: this.options.timeoutMs,
      headers: {
        'user-agent': 'OCSO-Webhooks/1',
        'x-ocso-event': envelope.type,
        'x-ocso-delivery': deliveryId,
        'x-ocso-signature': signatureHeader(secret, body, Math.floor(Date.now() / 1000)),
      },
    });
    if (result.kind === 'error') return { ok: false, retriable: true, error: result.reason === 'timeout' ? 'request timed out' : 'network error', status: null };
    if (result.status >= 200 && result.status < 300) return { ok: true, status: result.status };
    return { ok: false, retriable: isRetriableStatus(result.status), error: `HTTP ${result.status}`, status: result.status };
  }

  private async finish(deliveryId: string, attempts: number, outcome: Outcome): Promise<'SENT' | 'FAILED'> {
    const status = outcome.ok ? 'SENT' : 'FAILED';
    await this.options.db
      .update(webhookDeliveries)
      .set({ status, attempts, responseStatus: outcome.status, lastError: outcome.ok ? null : outcome.error, ...(outcome.ok ? { sentAt: new Date() } : {}) })
      .where(eq(webhookDeliveries.id, deliveryId));
    return status;
  }
}
