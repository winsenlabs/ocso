import { isPluginError, type ChannelRuntimeConfig, type OutboundMediaResolver, type RawHttpRequest } from '@winsendotai/ocso-plugin-sdk';
import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import plugin, { createJsonWebhookAdapter, IDENTITY_KIND, sign, SIGNATURE_HEADER } from '../src/index.js';

const SECRET = 'a-shared-secret-of-32-characters';
const config: ChannelRuntimeConfig = { id: 'ch1', kind: 'JSON_WEBHOOK', name: 'Partner', settings: { outboundUrl: 'https://partner.example.com/ocso' }, secrets: { signingSecret: SECRET } };
const now = new Date('2026-09-23T10:00:00Z');
const noMedia: OutboundMediaResolver = { signedUrl: () => Promise.reject(new Error('none')), read: () => Promise.reject(new Error('none')) };

function request(body: unknown, signature?: string): RawHttpRequest {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return { method: 'POST', headers: { [SIGNATURE_HEADER]: signature ?? sign(SECRET, raw) }, query: {}, rawBody: Buffer.from(raw) };
}

function adapterWith(fetch: (url: string | URL, init?: RequestInit) => Promise<Response> = () => Promise.reject(new Error('offline'))) {
  return createJsonWebhookAdapter({ fetch, now: () => now });
}

describe('example JSON-webhook channel plugin', () => {
  it('passes the SDK conformance checks', () => {
    expect(checkPlugin(plugin)).toEqual([]);
  });

  it('validates its settings and secret', () => {
    const adapter = adapterWith();
    expect(adapter.validateConfig(config.settings, config.secrets)).toEqual([]);
    expect(adapter.validateConfig({ outboundUrl: 'http://x.example.com' }, { signingSecret: 'short' })).toEqual([
      'Outbound URL must be an https:// URL',
      'Signing secret must be at least 16 characters',
    ]);
  });

  it('verifies the body signature', () => {
    const adapter = adapterWith();
    expect(adapter.verifyRequest(request({ messages: [] }), config)).toEqual({ kind: 'verified' });
    expect(adapter.verifyRequest(request({ messages: [] }, sign('another-secret-entirely', '{}')), config)).toMatchObject({ kind: 'rejected', status: 401 });
    expect(adapter.verifyRequest({ ...request({}), method: 'GET', rawBody: null }, config)).toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('parses messages and delivery statuses', () => {
    const envelope = adapterWith().parseInbound(
      request({
        messages: [{ id: 'm1', from: 'user-42', name: 'Priya', text: 'Hello', sentAt: '2026-09-23T09:59:00Z' }],
        statuses: [{ id: 'out-1', status: 'delivered' }, { id: 'out-2', status: 'exploded' }],
      }),
      config,
    );
    expect(envelope.messages).toEqual([
      {
        externalMessageId: 'm1',
        identityKind: IDENTITY_KIND,
        identityValue: 'user-42',
        alternateIdentities: [],
        profileName: 'Priya',
        receivedAt: new Date('2026-09-23T09:59:00Z'),
        parts: [{ type: 'TEXT', text: 'Hello' }],
      },
    ]);
    expect(envelope.statuses).toEqual([{ externalMessageId: 'out-1', status: 'DELIVERED', occurredAt: now }]);
    expect(envelope.ignored).toBe(1);
  });

  it('throws typed plugin errors for bad payloads and media', async () => {
    const adapter = adapterWith();
    const thrown = (() => {
      try {
        adapter.parseInbound(request('not json'), config);
      } catch (e) {
        return e;
      }
    })();
    expect(isPluginError(thrown) && thrown.ocsoError).toEqual({ category: 'validation', code: 'json_webhook_payload_invalid' });
    expect(() => adapter.parseInbound(request({ messages: [{ id: 'm1' }] }), config)).toThrow('A message needs id, from and text');
    await expect(adapter.fetchMedia({ mimeType: 'image/png', status: 'PENDING' }, config)).rejects.toSatisfy(isPluginError);
  });

  it('renders text and choice fallbacks, chunked', () => {
    const rendered = adapterWith().render(
      [
        { type: 'TEXT', text: 'x'.repeat(4_500) },
        { type: 'STRUCTURED', schema: 'ocso.choices', data: {}, fallbackText: 'Pick one\n\n1. A' },
      ],
      config,
    );
    expect(rendered.map((r) => [r.partIndexes, String(r.payload['text']).length])).toEqual([
      [[0], 4_000],
      [[0], 500],
      [[1], 14],
    ]);
  });

  it('sends signed JSON through the injected fetch and classifies failures', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let status = 202;
    const adapter = adapterWith((url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(null, { status }));
    });
    const target = { identityKind: IDENTITY_KIND, identityValue: 'user-42', lastInboundAt: now };
    const message = { kind: 'JSON_WEBHOOK', payload: { type: 'text', text: 'Hi' }, partIndexes: [0] };
    const sent = await adapter.send(target, message, config, noMedia);
    expect(sent.ok).toBe(true);
    const body = String(calls[0]?.init?.body);
    expect(JSON.parse(body)).toMatchObject({ to: 'user-42', text: 'Hi' });
    expect((calls[0]?.init?.headers as Record<string, string>)[SIGNATURE_HEADER]).toBe(sign(SECRET, body));
    status = 503;
    expect(await adapter.send(target, message, config, noMedia)).toMatchObject({ ok: false, errorCode: 'http_503', retriable: true });
    status = 400;
    expect(await adapter.send(target, message, config, noMedia)).toMatchObject({ ok: false, retriable: false });
    expect(await adapterWith().send(target, message, config, noMedia)).toMatchObject({ ok: false, errorCode: 'network', retriable: true });
  });
});
