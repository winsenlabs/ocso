import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { alertDeliveries, alerts, auditEvents, notificationDestinations, uuidv7 } from '@ocso/db';
import { createDefaultDeliveryRegistry, type FetchFn } from '@ocso/alerts';
import type { Principal } from '@ocso/auth';
import { EmailSendError, type EmailMessage, type EmailSender } from '@ocso/email';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { AlertDeliveryService, EmailSettingsService, NotificationDestinationService, isAlertDeliveryRetryable, type ActorContext } from '../src/index.js';

/** EMAIL destinations through the deployment sender (EMAIL_SENDER) and the Settings test send. */
let t: TestDatabase;
const rows = new InMemorySecretRows();
const secrets = new LocalSecretStore(rows, parseMasterKey('k1', randomBytes(32).toString('base64')));

const sent: EmailMessage[] = [];
let failNext: Error | null = null;
const sender: EmailSender = {
  driver: 'resend',
  from: 'OCSO Alerts <alerts@mail.meridian.test>',
  async send(message) {
    if (failNext) {
      const error = failNext;
      failNext = null;
      throw error;
    }
    sent.push(message);
    return { id: `resend-${sent.length}` };
  },
};
const noFetch: FetchFn = async () => new Response('unexpected', { status: 500 });
const registry = createDefaultDeliveryRegistry({ fetch: noFetch, emailSender: sender });

const ctx = (principal: Principal): ActorContext => ({ principal, correlationId: 'test' });
const principal = (role: Principal['role']): Principal => ({ userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' });
const admin = principal('TECH');
const lead = principal('HEAD');
const destinations = () => new NotificationDestinationService(t.db, secrets, registry, { baseUrl: 'https://ocso.test' });
const deliveries = () => new AlertDeliveryService({ db: t.db, secrets, registry, baseUrl: 'https://ocso.test', maxAttempts: 3 });

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [admin, lead]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.userId}@x.test`, p.role, p.role]);
  }
});
afterAll(async () => {
  await t?.drop();
});

describe('EMAIL destinations · deployment sender', () => {
  it('defaults to the deployment sender, refuses a secret for it, and test-sends through it', async () => {
    const dest = await destinations().create(ctx(admin), { name: 'On-call', kind: 'EMAIL', config: { to: ['oncall@meridian.test'] }, enabled: true });
    expect(dest).toMatchObject({ config: { transport: 'deployment', to: ['oncall@meridian.test'] }, hasSecret: false });
    await expect(
      destinations().create(ctx(admin), { name: 'x', kind: 'EMAIL', config: { to: ['oncall@meridian.test'] }, secret: 'pw', enabled: true }),
    ).rejects.toMatchObject({ code: 'secret_not_supported' });

    sent.length = 0;
    expect(await destinations().test(ctx(admin), dest.id)).toEqual({ ok: true, retriable: false });
    expect(sent[0]).toMatchObject({ to: ['oncall@meridian.test'], subject: '[OCSO INFO] Test alert from OCSO', tags: { kind: 'alert', event: 'OPENED', severity: 'INFO' } });
    expect(sent[0]!.text).toContain('Sent by OCSO for My organization · PROD.');
  });

  it('keeps legacy SMTP configs on SMTP with their password; switching to the deployment sender drops it', async () => {
    const legacy = await destinations().create(ctx(admin), {
      name: 'Legacy SMTP',
      kind: 'EMAIL',
      config: { host: 'smtp.meridian.test', from: 'alerts@meridian.test', to: ['a@meridian.test'] },
      secret: 'smtp-password-1',
      enabled: true,
    });
    expect(legacy).toMatchObject({ config: { transport: 'smtp', host: 'smtp.meridian.test', port: 587 }, hasSecret: true });
    const [before] = await t.db.select().from(notificationDestinations).where(eq(notificationDestinations.id, legacy.id));
    // A rename leaves the SMTP password alone, even for rows stored without `transport`.
    await t.db.update(notificationDestinations).set({ config: { host: 'smtp.meridian.test', from: 'alerts@meridian.test', to: ['a@meridian.test'] } }).where(eq(notificationDestinations.id, legacy.id));
    expect(await destinations().update(ctx(admin), legacy.id, { name: 'Legacy SMTP relay' })).toMatchObject({ hasSecret: true });
    const switched = await destinations().update(ctx(admin), legacy.id, { config: { transport: 'deployment', to: ['a@meridian.test'] } });
    expect(switched).toMatchObject({ config: { transport: 'deployment', to: ['a@meridian.test'] }, hasSecret: false });
    expect(await secrets.describe(before!.secretRef!)).toBeNull();
  });

  it('delivers alerts idempotently per delivery; retries transient sender errors, fails permanent ones', async () => {
    const dest = await destinations().create(ctx(admin), { name: 'Ops email', kind: 'EMAIL', config: { to: ['ops@meridian.test'] }, enabled: true });
    const alertId = uuidv7();
    await t.db.insert(alerts).values({ id: alertId, fingerprint: `f-${alertId}`, kind: 'TECHNICAL', severity: 'CRITICAL', title: 'Provider down', body: 'All requests failing', audienceRoles: ['TECH'], source: 'Provider · X' });
    const delivery = async () => {
      const id = uuidv7();
      await t.db.insert(alertDeliveries).values({ id, alertId, destinationId: dest.id, event: 'OPENED' });
      return id;
    };

    const first = await delivery();
    failNext = new EmailSendError('Resend HTTP 429 (rate_limit_exceeded)', true, 429, 'rate_limited');
    const error = await deliveries().deliver(first).catch((e: unknown) => e);
    expect(isAlertDeliveryRetryable(error)).toBe(true);
    sent.length = 0;
    expect(await deliveries().deliver(first)).toEqual({ status: 'SENT', attempts: 2 });
    expect(sent[0]).toMatchObject({ to: ['ops@meridian.test'], subject: '[OCSO CRITICAL] Provider down', idempotencyKey: `alert-delivery/${first}` });
    expect(sent[0]!.text).toContain(`Open in OCSO: https://ocso.test/alerts/${alertId}`);

    const second = await delivery();
    failNext = new EmailSendError('Resend HTTP 403 (validation_error: The domain is not verified)', false, 403, 'auth');
    expect(await deliveries().deliver(second)).toEqual({ status: 'FAILED', attempts: 1, error: 'Resend HTTP 403 (validation_error: The domain is not verified)' });
  });
});

describe('EmailSettingsService', () => {
  const status = { driver: 'resend', label: 'Resend', from: sender.from, replyTo: null, configured: true, warnings: [] };
  const service = () => new EmailSettingsService(t.db, sender, status);

  it('shows the status to the Tech admin only', () => {
    expect(service().status(ctx(admin))).toEqual(status);
    expect(() => service().status(ctx(lead))).toThrow();
  });

  it('sends an audited test email and reports failures by category', async () => {
    sent.length = 0;
    expect(await service().sendTest(ctx(admin), { to: 'tarun@meridian.test' })).toEqual({ ok: true, driver: 'resend', label: 'Resend', delivers: true, id: 'resend-1' });
    expect(sent[0]).toMatchObject({ to: 'tarun@meridian.test', subject: 'OCSO test email', tags: { kind: 'test' } });
    expect(sent[0]!.idempotencyKey).toMatch(/^email-test\//);
    failNext = new EmailSendError('Resend request timed out', true, null, 'network');
    expect(await service().sendTest(ctx(admin), { to: 'tarun@meridian.test' })).toEqual({
      ok: false,
      driver: 'resend',
      label: 'Resend',
      delivers: true,
      id: null,
      error: 'Resend request timed out',
      category: 'network',
      retriable: true,
    });
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'email.test_send'));
    expect(audit.map((a) => a.summary)).toEqual([
      'Test email (resend) to 1 recipient @meridian.test: sent',
      'Test email (resend) to 1 recipient @meridian.test: failed (network)',
    ]);
    await expect(service().sendTest(ctx(lead), { to: 'x@meridian.test' })).rejects.toMatchObject({ category: 'authorization' });
  });
});
