import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWebhookAdapter, verifySignature, type WebhookEnvelope } from '../src/index.js';
import { NOW, fakeFetch, message } from './helpers.js';

const SECRET = 'whsec_0123456789abcdef';
const URL_ = 'https://hooks.example.com/ocso/alerts';
const TS = Math.floor(NOW.getTime() / 1000);

function setup(respond?: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(respond);
  return { adapter: createWebhookAdapter({ fetch, now: () => NOW }), calls };
}

describe('Webhook adapter', () => {
  it('signs `${ts}.${body}` with HMAC-SHA256 in X-OCSO-Signature', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.deliver(message(), { url: URL_ }, SECRET)).toEqual({ ok: true, retriable: false });
    const call = calls[0]!;
    expect(call).toMatchObject({ url: URL_, method: 'POST', redirect: 'error' });
    const header = call.headers.get('x-ocso-signature')!;
    const expected = createHmac('sha256', SECRET).update(`${TS}.${call.rawBody}`).digest('hex');
    expect(header).toBe(`t=${TS},v1=${expected}`);
    expect(verifySignature(header, call.rawBody, SECRET, { nowSeconds: TS + 10 })).toBe(true);
    expect(call.headers.get('x-ocso-event')).toBe('alert.opened');
    expect(call.headers.get('x-ocso-delivery')).toBe(message().deliveryId);
  });

  it('sends a versioned alert envelope', async () => {
    const { adapter, calls } = setup();
    await adapter.deliver(message({ event: 'ACKNOWLEDGED', status: 'ACKNOWLEDGED', acknowledgedAt: NOW.toISOString() }), { url: URL_ }, SECRET);
    const envelope = calls[0]!.body as WebhookEnvelope;
    expect(envelope).toMatchObject({
      type: 'alert.acknowledged',
      version: 1,
      deliveryId: message().deliveryId,
      occurredAt: NOW.toISOString(),
      deployment: 'Meridian Bank · PROD',
      alert: { alertId: message().alertId, fingerprint: message().fingerprint, severity: 'CRITICAL', status: 'ACKNOWLEDGED', context: { providerId: 'p-1' } },
    });
    expect(envelope.alert).not.toHaveProperty('deliveryId');
    expect(calls[0]!.rawBody).not.toContain(SECRET);
  });

  it('rejects tampered bodies, wrong secrets and stale timestamps', async () => {
    const { adapter, calls } = setup();
    await adapter.deliver(message(), { url: URL_ }, SECRET);
    const { rawBody } = calls[0]!;
    const header = calls[0]!.headers.get('x-ocso-signature');
    expect(verifySignature(header, rawBody.replace('CRITICAL', 'INFO'), SECRET, { nowSeconds: TS })).toBe(false);
    expect(verifySignature(header, rawBody, 'another-secret-value', { nowSeconds: TS })).toBe(false);
    expect(verifySignature(header, rawBody, SECRET, { nowSeconds: TS + 301 })).toBe(false);
    expect(verifySignature('t=abc,v1=zz', rawBody, SECRET, { nowSeconds: TS })).toBe(false);
    expect(verifySignature(null, rawBody, SECRET, { nowSeconds: TS })).toBe(false);
  });

  it('maps receiver status codes; the body is never echoed', async () => {
    const gone = setup(() => new Response('secret-ish receiver body', { status: 410 }));
    expect(await gone.adapter.deliver(message(), { url: URL_ }, SECRET)).toEqual({ ok: false, retriable: false, error: 'HTTP 410' });
    const flaky = setup(() => new Response('', { status: 502 }));
    expect(await flaky.adapter.deliver(message(), { url: URL_ }, SECRET)).toEqual({ ok: false, retriable: true, error: 'HTTP 502' });
    const limited = setup(() => new Response('', { status: 429 }));
    expect((await limited.adapter.deliver(message(), { url: URL_ }, SECRET)).retriable).toBe(true);
  });

  it('validates URL config and signing secret', async () => {
    const { adapter } = setup();
    expect(adapter.validateConfig({ url: URL_ })).toEqual({ ok: true, config: { url: URL_ } });
    expect(adapter.validateConfig({ url: 'http://hooks.example.com/x' })).toEqual({ ok: false, problems: ['url: url must use https'] });
    expect(adapter.validateConfig({ url: 'https://a:b@hooks.example.com/x' }).ok).toBe(false);
    expect(adapter.validateConfig({}).ok).toBe(false);
    expect(adapter.validateSecret('short')).toHaveLength(1);
    expect(adapter.validateSecret(SECRET)).toEqual([]);
    expect(await adapter.deliver(message(), { url: URL_ }, null)).toMatchObject({ ok: false, retriable: false });
  });
});
