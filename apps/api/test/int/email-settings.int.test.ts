import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addUserWithPassword, completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * Deployment email: env-configured Resend sender (EMAIL_SENDER), the read-only
 * settings view, the audited test send and alert emails via the deployment
 * sender. Resend itself is faked by intercepting global fetch for its host only.
 */
const API_KEY = 're_int_test_0123456789abcdef';
const FROM = 'Meridian Support <support@mail.meridian.test>';
let h: ApiHarness;
const tokens = { admin: '', lead: '' };
const as = (who: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[who]}` });

const resendCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
let resendReply: () => Response = () => Response.json({ id: 'resend-msg-1' });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  Object.assign(process.env, { EMAIL_DRIVER: 'resend', EMAIL_FROM: FROM, EMAIL_REPLY_TO: 'help@meridian.test', RESEND_API_KEY: API_KEY });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.resend.com/')) return realFetch(input, init);
    resendCalls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return resendReply();
  });
  h = await startApi();
  tokens.admin = await completeSetup(h);
  // Email is configured here, so the API only invites (ADR-025); the lead gets a password directly.
  await addUserWithPassword(h, { email: 'lead@ocso.test', name: 'Lead', role: 'HEAD', password: 'correct password 1234' });
  tokens.lead = await h.loginAs('lead@ocso.test', 'correct password 1234');
});
afterAll(async () => {
  await h?.close();
  vi.unstubAllGlobals();
});

describe('GET /v1/settings/email', () => {
  it('shows the Tech admin driver, from and reply-to — never the key', async () => {
    const res = await h.http().get('/v1/settings/email').set(as('admin')).expect(200);
    expect(res.body).toEqual({ driver: 'resend', label: 'Resend', from: FROM, replyTo: 'help@meridian.test', configured: true, warnings: [] });
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
  });

  it('is limited to deployment_settings.manage', async () => {
    await h.http().get('/v1/settings/email').expect(401);
    await h.http().get('/v1/settings/email').set(as('lead')).expect(403);
    await h.http().post('/v1/settings/email/test').set(as('lead')).send({ to: 'a@meridian.test' }).expect(403);
  });
});

describe('POST /v1/settings/email/test', () => {
  it('sends through Resend with the configured sender and records an audit event', async () => {
    resendCalls.length = 0;
    const res = await h.http().post('/v1/settings/email/test').set(as('admin')).send({ to: 'tarun@meridian.test' }).expect(200);
    expect(res.body).toEqual({ ok: true, driver: 'resend', label: 'Resend', delivers: true, id: 'resend-msg-1' });
    const call = resendCalls[0]!;
    expect(call.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(call.headers.get('idempotency-key')).toMatch(/^email-test\//);
    expect(call.body).toMatchObject({ from: FROM, to: ['tarun@meridian.test'], subject: 'OCSO test email', reply_to: 'help@meridian.test', tags: [{ name: 'kind', value: 'test' }] });
    expect(String(call.body['html'])).toContain('Sent by OCSO for Meridian Bank.');
    const audit = await h.db.pool.query(`SELECT summary, after FROM audit_events WHERE action = 'email.test_send' ORDER BY occurred_at ASC LIMIT 1`);
    expect(audit.rows[0]).toMatchObject({ summary: 'Test email (resend) to 1 recipient @meridian.test: sent', after: { to: 'tarun@meridian.test', ok: true } });
    expect(JSON.stringify(audit.rows)).not.toContain(API_KEY);
  });

  it('reports provider failures by category without leaking the key', async () => {
    resendReply = () => Response.json({ statusCode: 403, name: 'validation_error', message: `The mail.meridian.test domain is not verified (key ${API_KEY})` }, { status: 403 });
    const res = await h.http().post('/v1/settings/email/test').set(as('admin')).send({ to: 'tarun@meridian.test' }).expect(200);
    expect(res.body).toMatchObject({ ok: false, driver: 'resend', id: null, category: 'auth', retriable: false });
    expect(res.body.error).toContain('Resend HTTP 403 (validation_error: The mail.meridian.test domain is not verified');
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);
    resendReply = () => Response.json({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' }, { status: 429 });
    expect((await h.http().post('/v1/settings/email/test').set(as('admin')).send({ to: 'tarun@meridian.test' }).expect(200)).body).toMatchObject({ ok: false, category: 'rate_limited', retriable: true });
    await h.http().post('/v1/settings/email/test').set(as('admin')).send({ to: 'not-an-address' }).expect(400);
    resendReply = () => Response.json({ id: 'resend-msg-1' });
  });
});

describe('alert email destinations via the deployment sender', () => {
  it('creates an EMAIL destination with recipients only and test-sends it through Resend', async () => {
    const created = await h
      .http()
      .post('/v1/notification-destinations')
      .set(as('admin'))
      .send({ name: 'On-call email', kind: 'EMAIL', config: { to: ['oncall@meridian.test'] } })
      .expect(201);
    expect(created.body).toMatchObject({ kind: 'EMAIL', config: { transport: 'deployment', to: ['oncall@meridian.test'] }, hasSecret: false });
    await h
      .http()
      .post('/v1/notification-destinations')
      .set(as('admin'))
      .send({ name: 'Bad', kind: 'EMAIL', config: { to: ['oncall@meridian.test'] }, secret: 'smtp-password' })
      .expect(400);

    resendCalls.length = 0;
    const tested = await h.http().post(`/v1/notification-destinations/${created.body.id}/test`).set(as('admin')).expect(200);
    expect(tested.body).toEqual({ ok: true, retriable: false });
    expect(resendCalls[0]!.body).toMatchObject({ from: FROM, to: ['oncall@meridian.test'], subject: '[OCSO INFO] Test alert from OCSO' });
    expect(resendCalls[0]!.headers.get('idempotency-key')).toMatch(/^alert-delivery\//);
  });
});
