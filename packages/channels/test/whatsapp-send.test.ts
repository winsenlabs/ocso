import { describe, expect, it } from 'vitest';
import type { InteractionPart } from '@ocso/domain';
import { createWhatsAppAdapter, type RenderedOutbound, type SendResult } from '../src/index.js';
import {
  ACCESS_TOKEN,
  APP_SECRET,
  fakeFetch,
  GRAPH,
  graphError,
  json,
  mediaResolver,
  NOW,
  PHONE_NUMBER_ID,
  target,
  waConfig,
} from './helpers/whatsapp.js';

const OK = json({ messaging_product: 'whatsapp', contacts: [{ input: '16505551234', wa_id: '16505551234' }], messages: [{ id: 'wamid.OUT.123' }] });

function setup(respond: (url: string) => Response | Promise<Response> = () => OK.clone()) {
  const { fetch, calls } = fakeFetch(respond);
  return { adapter: createWhatsAppAdapter({ fetch, now: () => NOW }), calls };
}

const text = (body = 'Your card ending 4821 is blocked.'): RenderedOutbound => ({
  kind: 'WHATSAPP',
  payload: { type: 'text', body, previewUrl: false },
  partIndexes: [0],
});

describe('WhatsApp send — success', () => {
  it('POSTs to /{phone-number-id}/messages with messaging_product and returns the wamid', async () => {
    const { adapter, calls } = setup();
    const result = await adapter.send(target(), text(), waConfig(), mediaResolver());
    expect(result).toEqual({ ok: true, externalMessageId: 'wamid.OUT.123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${GRAPH}/${PHONE_NUMBER_ID}/messages`, method: 'POST', redirect: 'error' });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(calls[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '16505551234',
      type: 'text',
      text: { body: 'Your card ending 4821 is blocked.', preview_url: false },
    });
  });

  it('uses target.channelAccountId (multi-number) over the default phone number id', async () => {
    const { adapter, calls } = setup();
    await adapter.send(target({ channelAccountId: '109999999999999' }), text(), waConfig(), mediaResolver());
    expect(calls[0]?.url).toBe(`${GRAPH}/109999999999999/messages`);
  });

  it('addresses BSUID identities via `recipient`', async () => {
    const { adapter, calls } = setup();
    await adapter.send(target({ identityKind: 'whatsapp_bsuid', identityValue: 'US.13491208655302741918' }), text(), waConfig(), mediaResolver());
    expect(calls[0]?.body).toMatchObject({ recipient: 'US.13491208655302741918' });
    expect(calls[0]?.body).not.toHaveProperty('to');
  });

  it('honours the configured Graph version and base URL', async () => {
    const { adapter, calls } = setup();
    await adapter.send(target(), text(), waConfig({ graphApiVersion: 'v25.0', graphBaseUrl: 'http://localhost:4010/' }), mediaResolver());
    expect(calls[0]?.url).toBe(`http://localhost:4010/v25.0/${PHONE_NUMBER_ID}/messages`);
  });

  it('end-to-end: render then send every payload of a multi-part reply', async () => {
    const { adapter, calls } = setup();
    const parts: InteractionPart[] = [
      { type: 'TEXT', text: 'Here is your **statement**:' },
      { type: 'DOCUMENT', media: { status: 'STORED', blobKey: 'outbound/stmt.pdf', mimeType: 'application/pdf', filename: 'stmt.pdf' } },
      { type: 'LOCATION', latitude: 19.076, longitude: 72.8777 },
    ];
    const results: SendResult[] = [];
    for (const rendered of adapter.render(parts, waConfig())) results.push(await adapter.send(target(), rendered, waConfig(), mediaResolver()));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.map((c) => (c.body as Record<string, unknown>)['type'])).toEqual(['text', 'document', 'location']);
    expect(calls[1]?.body).toMatchObject({
      document: { link: 'https://blobs.ocso.example/outbound/stmt.pdf?ttl=900&sig=abc', filename: 'stmt.pdf' },
    });
  });
});

describe('WhatsApp send — media resolution', () => {
  const image: RenderedOutbound = {
    kind: 'WHATSAPP',
    payload: { type: 'media', mediaType: 'image', blobKey: 'outbound/photo.jpg', mimeType: 'image/jpeg', caption: 'Receipt' },
    partIndexes: [0],
  };

  it('link mode sends a short-lived signed URL', async () => {
    const { adapter, calls } = setup();
    await adapter.send(target(), image, waConfig({ mediaLinkTtlSeconds: 300 }), mediaResolver());
    expect(calls[0]?.body).toMatchObject({ type: 'image', image: { link: 'https://blobs.ocso.example/outbound/photo.jpg?ttl=300&sig=abc', caption: 'Receipt' } });
  });

  it('upload mode uploads to /{phone-number-id}/media and sends by id', async () => {
    const { adapter, calls } = setup((url) => (url.endsWith('/media') ? json({ id: '4490709327384033' }) : OK.clone()));
    const result = await adapter.send(target(), image, waConfig({ outboundMediaMode: 'upload' }), mediaResolver());
    expect(result).toEqual({ ok: true, externalMessageId: 'wamid.OUT.123' });
    expect(calls.map((c) => c.url)).toEqual([`${GRAPH}/${PHONE_NUMBER_ID}/media`, `${GRAPH}/${PHONE_NUMBER_ID}/messages`]);
    const form = calls[0]?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('image/jpeg');
    expect(calls[1]?.body).toMatchObject({ image: { id: '4490709327384033', caption: 'Receipt' } });
  });

  it('a failing blob resolver is a retriable media_unavailable failure, with no Graph call', async () => {
    const { adapter, calls } = setup();
    const broken = mediaResolver({ signedUrl: () => Promise.reject(new Error('s3 down')) });
    expect(await adapter.send(target(), image, waConfig(), broken)).toMatchObject({ ok: false, errorCode: 'media_unavailable', retriable: true });
    expect(calls).toHaveLength(0);
  });
});

describe('WhatsApp send — 24-hour session window', () => {
  it('refuses free-form messages outside the window without calling Meta', async () => {
    const { adapter, calls } = setup();
    const stale = target({ lastInboundAt: new Date(NOW.getTime() - 25 * 3_600_000) });
    expect(await adapter.send(stale, text(), waConfig(), mediaResolver())).toEqual({
      ok: false,
      errorCode: 'outside_session_window',
      message: expect.any(String),
      retriable: false,
      requiresTemplate: true,
    });
    expect(await adapter.send(target({ lastInboundAt: null }), text(), waConfig(), mediaResolver())).toMatchObject({ requiresTemplate: true });
    expect(calls).toHaveLength(0);
  });

  it('allows messages just inside the window', async () => {
    const { adapter } = setup();
    const recent = target({ lastInboundAt: new Date(NOW.getTime() - 23.9 * 3_600_000) });
    expect(await adapter.send(recent, text(), waConfig(), mediaResolver())).toMatchObject({ ok: true });
  });
});

describe('WhatsApp templates', () => {
  const template = {
    name: 'payment_reminder',
    language: 'en_US',
    components: [{ type: 'body', parameters: [{ type: 'text', text: '₹4,200' }] }],
  };

  it('sendTemplate works outside the session window', async () => {
    const { adapter, calls } = setup();
    const stale = target({ lastInboundAt: new Date(NOW.getTime() - 72 * 3_600_000) });
    expect(await adapter.sendTemplate(stale, template, waConfig())).toEqual({ ok: true, externalMessageId: 'wamid.OUT.123' });
    expect(calls[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '16505551234',
      type: 'template',
      template: { name: 'payment_reminder', language: { code: 'en_US' }, components: template.components },
    });
  });

  it('renderTemplate produces an outbox-storable payload; invalid templates are typed errors', async () => {
    const { adapter } = setup();
    expect(adapter.renderTemplate(template)).toMatchObject({ kind: 'WHATSAPP', payload: { type: 'template' }, partIndexes: [] });
    expect(() => adapter.renderTemplate({ name: 'Bad Name!', language: 'english' })).toThrowError(
      expect.objectContaining({ category: 'validation', code: 'invalid_whatsapp_template' }),
    );
    expect(await adapter.sendTemplate(target(), { name: '', language: 'en' }, waConfig())).toMatchObject({ ok: false, errorCode: 'invalid_template' });
  });

  it('template errors from Meta are not retriable', async () => {
    const { adapter } = setup(() => graphError(400, 132001, 'Template name does not exist in the translation'));
    expect(await adapter.sendTemplate(target(), template, waConfig())).toMatchObject({ ok: false, errorCode: 'template_error', retriable: false });
  });
});

describe('WhatsApp send — error mapping', () => {
  it.each([
    [400, 131047, 'outside_session_window', false, true],
    [400, 131056, 'rate_limited_pair', true, undefined],
    [400, 130429, 'rate_limited', true, undefined],
    [400, 80007, 'rate_limited', true, undefined],
    [401, 190, 'auth_failed', false, undefined],
    [403, 200, 'permission_denied', false, undefined],
    [400, 131026, 'recipient_undeliverable', false, undefined],
    [400, 131049, 'engagement_limited', false, undefined],
    [400, 368, 'account_restricted', false, undefined],
    [400, 100, 'invalid_request', false, undefined],
    [500, 131000, 'provider_error', true, undefined],
    [400, 999999, 'provider_rejected', false, undefined],
  ])('HTTP %i / Meta %i -> %s (retriable=%s)', async (status, code, errorCode, retriable, requiresTemplate) => {
    const { adapter } = setup(() => graphError(status, code, 'Meta says no', 'details here'));
    const result = await adapter.send(target(), text(), waConfig(), mediaResolver());
    expect(result).toMatchObject({ ok: false, errorCode, retriable });
    expect(result.ok ? undefined : result.requiresTemplate).toBe(requiresTemplate);
    expect(result.ok ? '' : result.message).toContain(`Meta error ${code}`);
  });

  it.each([
    [429, 'rate_limited', true],
    [502, 'provider_unavailable', true],
    [503, 'provider_unavailable', true],
    [401, 'auth_failed', false],
    [404, 'provider_rejected', false],
  ])('HTTP %i without a Meta error body -> %s', async (status, errorCode, retriable) => {
    const { adapter } = setup(() => new Response('<html>Bad gateway</html>', { status }));
    expect(await adapter.send(target(), text(), waConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode, retriable });
  });

  it('network failures and timeouts are retriable (at-least-once)', async () => {
    const refused = setup(() => Promise.reject(new TypeError('fetch failed')));
    expect(await refused.adapter.send(target(), text(), waConfig(), mediaResolver())).toMatchObject({ errorCode: 'network_error', retriable: true });
    const slow = setup(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    expect(await slow.adapter.send(target(), text(), waConfig(), mediaResolver())).toMatchObject({ errorCode: 'timeout', retriable: true });
  });

  it('never includes tokens or secrets in error messages', async () => {
    const leaky = `Invalid token ${ACCESS_TOKEN} (app secret ${APP_SECRET}) Authorization: Bearer ${ACCESS_TOKEN} url?access_token=${ACCESS_TOKEN}`;
    const { adapter } = setup(() => graphError(401, 190, leaky));
    const result = await adapter.send(target(), text(), waConfig(), mediaResolver());
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).toContain('[REDACTED]');
  });

  it('an accepted response without a message id is not retried (would duplicate)', async () => {
    const { adapter } = setup(() => json({ messaging_product: 'whatsapp', messages: [] }));
    expect(await adapter.send(target(), text(), waConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'provider_error', retriable: false });
  });
});

describe('WhatsApp send — input validation', () => {
  it('rejects foreign or malformed payloads, bad recipients and bad config without network I/O', async () => {
    const { adapter, calls } = setup();
    const foreign: RenderedOutbound = { kind: 'WEBCHAT', payload: { type: 'message', parts: [] }, partIndexes: [] };
    expect(await adapter.send(target(), foreign, waConfig(), mediaResolver())).toMatchObject({ errorCode: 'invalid_payload' });
    const tooLong = text('x'.repeat(4097));
    expect(await adapter.send(target(), tooLong, waConfig(), mediaResolver())).toMatchObject({ errorCode: 'invalid_payload' });
    expect(await adapter.send(target({ identityKind: 'webchat_visitor', identityValue: 'v_1' }), text(), waConfig(), mediaResolver())).toMatchObject({
      errorCode: 'invalid_recipient',
    });
    expect(await adapter.send(target({ channelAccountId: '../../me' }), text(), waConfig(), mediaResolver())).toMatchObject({
      errorCode: 'invalid_channel_account',
    });
    const broken = await adapter.send(target(), text(), waConfig({}, { accessToken: '' }), mediaResolver());
    expect(broken).toMatchObject({ ok: false, errorCode: 'invalid_channel_config', retriable: false });
    expect(calls).toHaveLength(0);
  });

  it('markRead sends a read receipt with an optional typing indicator', async () => {
    const { adapter, calls } = setup(() => json({ success: true }));
    const result = await adapter.markRead('wamid.IN.1', waConfig(), { typingIndicator: true });
    expect(result).toEqual({ ok: true, externalMessageId: 'wamid.IN.1' });
    expect(calls[0]?.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN.1', typing_indicator: { type: 'text' } });
  });
});
