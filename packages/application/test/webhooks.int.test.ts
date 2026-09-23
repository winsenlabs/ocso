import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { verifySignature } from '@ocso/alerts';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { outboxEvents, uuidv7, webhookDeliveries } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import type { Principal } from '@ocso/auth';
import { WebhookDeliveryService, WebhookService, emitEvent, isWebhookRetryable, relayOutboxToWebhooks, sweepApprovalSecrets, type ActorContext } from '../src/index.js';
import { platformApprover, type PlatformApprover } from './support/platform-approvals.js';

let t: TestDatabase;
let secrets: LocalSecretStore;
const queue = new MemoryQueue();
const as = (role: Principal['role']): ActorContext => ({ principal: { userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' }, correlationId: 'c' });
const admin = as('TECH');
let service: WebhookService;
const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let respond: () => Response = () => new Response('ok', { status: 200 });
const fakeFetch = async (url: string | URL, init?: RequestInit) => {
  sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
  return respond();
};
let delivery: WebhookDeliveryService;
let approver: PlatformApprover;

beforeAll(async () => {
  t = await createTestDatabase();
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  service = new WebhookService(t.db, secrets, queue);
  delivery = new WebhookDeliveryService({ db: t.db, secrets, fetch: fakeFetch, maxAttempts: 3 });
  approver = await platformApprover(t.db, { secrets });
});
afterAll(async () => {
  await t?.drop();
});

const emit = (type: 'alert.opened' | 'config.changed' | 'tool.failed'): Promise<void> =>
  t.db.transaction(async (tx) => {
    if (type === 'alert.opened') await emitEvent(tx, { correlationId: 'corr-1' }, 'alert.opened', { alertId: uuidv7(), severity: 'CRITICAL', kind: 'TECHNICAL' });
    else if (type === 'tool.failed') await emitEvent(tx, { correlationId: 'corr-2' }, 'tool.failed', { toolCallId: uuidv7(), toolName: 'payments.reverse', errorCategory: 'tool_unavailable' });
    else await emitEvent(tx, { correlationId: 'corr-3' }, 'config.changed', { area: 'prompt', entityId: null });
  });

describe('outbound event webhooks (E8.10)', () => {
  it('validates subscriptions and returns the signing secret exactly once', async () => {
    await expect(service.create(as('HEAD'), { name: 'crm', url: 'https://crm.example.com/hook', events: ['alert.*'] })).rejects.toMatchObject({ category: 'authorization' });
    const { WebhookInput } = await import('../src/index.js');
    expect(WebhookInput.safeParse({ name: 'x', url: 'http://plain.example.com', events: ['alert.*'] }).success).toBe(false);
    expect(WebhookInput.safeParse({ name: 'x', url: 'https://a.example.com', events: ['config.changed'] }).success).toBe(false);
    expect(WebhookInput.safeParse({ name: 'x', url: 'https://a.example.com', events: ['alert.*', 'tool.failed'] }).success).toBe(true);
  });

  it('relays only matching events that occurred after the subscription, once', async () => {
    await emit('alert.opened'); // before the subscription exists
    const { id, signingSecret } = await service.create(admin, { name: 'pager', url: 'https://alerts.example.com/ocso', events: ['alert.*'] });
    expect(signingSecret).toMatch(/^whsec_/);
    // A new subscription is a disabled draft; a second person's approval enables it.
    expect((await service.get(id)).enabled).toBe(false);
    await approver.approve(admin, 'webhook_subscription', id, 'ACTIVATE');
    expect((await service.get(id)).enabled).toBe(true);
    await emit('alert.opened');
    await emit('config.changed');
    await emit('tool.failed');
    expect(await relayOutboxToWebhooks(t.db, queue)).toBe(1);
    expect(await relayOutboxToWebhooks(t.db, queue)).toBe(0);
    const rows = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, id));
    expect(rows.map((r) => r.eventType)).toEqual(['alert.opened']);
    const { rows: unpublished } = await t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
    expect(unpublished[0]!.n).toBe(0);

    expect(await delivery.deliver(rows[0]!.id)).toBe('SENT');
    const request = sent.at(-1)!;
    expect(request.url).toBe('https://alerts.example.com/ocso');
    expect(request.headers['x-ocso-event']).toBe('alert.opened');
    expect(verifySignature(request.headers['x-ocso-signature'], request.body, signingSecret, { nowSeconds: Math.floor(Date.now() / 1000) })).toBe(true);
    const envelope = JSON.parse(request.body);
    expect(envelope).toMatchObject({ id: rows[0]!.eventId, type: 'alert.opened', correlationId: 'corr-1', conversation: null, data: { severity: 'CRITICAL', kind: 'TECHNICAL' } });
    expect(await delivery.deliver(rows[0]!.id)).toBe('SKIPPED');
  });

  it('retries transient failures, fails permanently on client errors, and supports manual retry', async () => {
    const { id } = await service.create(admin, { name: 'ops', url: 'https://ops.example.com/events', events: ['tool.failed'] });
    await approver.approve(admin, 'webhook_subscription', id, 'ACTIVATE');
    await emit('tool.failed');
    await relayOutboxToWebhooks(t.db, queue);
    const [row] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, id));

    respond = () => new Response('busy', { status: 503 });
    await expect(delivery.deliver(row!.id)).rejects.toSatisfy(isWebhookRetryable);
    await expect(delivery.deliver(row!.id)).rejects.toSatisfy(isWebhookRetryable);
    expect(await delivery.deliver(row!.id)).toBe('FAILED'); // maxAttempts = 3
    const [failed] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row!.id));
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 3, responseStatus: 503, lastError: 'HTTP 503' });

    await service.retry(admin, row!.id);
    respond = () => new Response('nope', { status: 400 });
    expect(await delivery.deliver(row!.id)).toBe('FAILED');
    const [once] = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row!.id));
    expect(once!.attempts).toBe(1);

    respond = () => new Response(null, { status: 204 });
    expect(await delivery.sendTest(id)).toEqual({ ok: true, status: 204, error: null });
    expect(JSON.parse(sent.at(-1)!.body).type).toBe('webhook.test');
    const list = await service.list(admin);
    expect(list.find((w) => w.id === id)?.last24h).toEqual({ sent: 0, failed: 1, pending: 0 });
  });

  it('rotates the secret and stops delivering for disabled subscriptions', async () => {
    const { id, signingSecret } = await service.create(admin, { name: 'dwh', url: 'https://dwh.example.com/usage', events: ['*'] });
    await approver.approve(admin, 'webhook_subscription', id, 'ACTIVATE');
    // Rotating (a revocation) and disabling are immediate, even on an approved subscription.
    const { signingSecret: next } = await service.rotateSecret(admin, id);
    expect(next).not.toBe(signingSecret);
    await expect(service.update(admin, id, { url: 'https://dwh.example.com/v2' })).rejects.toMatchObject({ code: 'approval_required' });
    await service.disable(admin, id);
    await emit('alert.opened');
    await relayOutboxToWebhooks(t.db, queue);
    expect(await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, id))).toHaveLength(0);
    const ref = (await service.get(id)).signingSecretRef;
    await approver.approve(admin, 'webhook_subscription', id, 'DELETE');
    await expect(service.get(id)).rejects.toMatchObject({ category: 'not_found' });
    await sweepApprovalSecrets(t.db, secrets);
    expect(await secrets.describe(ref)).toBeNull();
    const events = await t.db.select({ n: sql<number>`count(*)::int` }).from(outboxEvents);
    expect(events[0]!.n).toBeGreaterThan(0);
  });
});
