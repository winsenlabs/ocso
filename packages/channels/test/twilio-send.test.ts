import { describe, expect, it } from 'vitest';
import { createTwilioWhatsAppAdapter, type RenderedOutbound } from '../src/index.js';
import { mediaResolver, target } from './helpers/whatsapp.js';
import {
  ACCOUNT_SID,
  API,
  API_KEY_SECRET,
  API_KEY_SID,
  AUTH_TOKEN,
  basic,
  messageCreated,
  MESSAGING_SERVICE_SID,
  NOW,
  SENDER,
  twConfig,
  twilioError,
  twilioFetch,
  twilioJson,
  WEBHOOK_URL,
} from './helpers/twilio.js';

function setup(respond: (url: string) => Response | Promise<Response> = () => messageCreated()) {
  const { fetch, calls } = twilioFetch(respond);
  return { adapter: createTwilioWhatsAppAdapter({ fetch, now: () => NOW }), calls };
}

const text = (body = 'Your card ending 4821 is blocked.'): RenderedOutbound => ({ kind: 'TWILIO_WHATSAPP', payload: { type: 'text', body }, partIndexes: [0] });
const form = (call: { form: URLSearchParams | null } | undefined) => Object.fromEntries(call?.form ?? []);
const customer = target({ identityValue: '+919812341208' });

describe('Twilio send — request shape', () => {
  it('POSTs form-encoded To/From/Body/StatusCallback to Messages.json with Basic auth and returns the SID', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.send(customer, text(), twConfig(), mediaResolver())).toEqual({ ok: true, externalMessageId: 'SMf0e1d2c3b4a5968778695a4b3c2d1e0f' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${API}/Messages.json`, method: 'POST', redirect: 'error' });
    expect(calls[0]?.headers.get('authorization')).toBe(basic(ACCOUNT_SID, AUTH_TOKEN));
    expect(calls[0]?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(form(calls[0])).toEqual({ To: 'whatsapp:+919812341208', From: SENDER, Body: 'Your card ending 4821 is blocked.', StatusCallback: WEBHOOK_URL });
  });

  it('uses the API key when configured, a Messaging Service instead of From, and no StatusCallback when turned off', async () => {
    const { adapter, calls } = setup();
    const config = twConfig({ from: undefined, messagingServiceSid: MESSAGING_SERVICE_SID, apiKeySid: API_KEY_SID, statusCallback: false }, { apiKeySecret: API_KEY_SECRET });
    await adapter.send(customer, text(), config, mediaResolver());
    expect(calls[0]?.headers.get('authorization')).toBe(basic(API_KEY_SID, API_KEY_SECRET));
    expect(form(calls[0])).toEqual({ To: 'whatsapp:+919812341208', MessagingServiceSid: MESSAGING_SERVICE_SID, Body: 'Your card ending 4821 is blocked.' });
  });

  it('omits StatusCallback without an https webhook URL; replies from the number the customer wrote to', async () => {
    const { adapter, calls } = setup();
    await adapter.send(target({ identityValue: '+919812341208', channelAccountId: 'whatsapp:+14155550123' }), text(), twConfig({}, {}, 'http://localhost:3000/channels/twilio-whatsapp/k/webhook'), mediaResolver());
    expect(form(calls[0])).toEqual({ To: 'whatsapp:+919812341208', From: 'whatsapp:+14155550123', Body: 'Your card ending 4821 is blocked.' });
  });

  it('media: one MediaUrl (short-lived signed blob URL), image caption as Body', async () => {
    const { adapter, calls } = setup();
    const image: RenderedOutbound = { kind: 'TWILIO_WHATSAPP', payload: { type: 'media', mediaKind: 'IMAGE', blobKey: 'outbound/r.jpg', mimeType: 'image/jpeg', caption: 'Receipt' }, partIndexes: [0] };
    await adapter.send(customer, image, twConfig({ mediaLinkTtlSeconds: 300 }), mediaResolver());
    expect(form(calls[0])).toMatchObject({ MediaUrl: 'https://blobs.ocso.example/outbound/r.jpg?ttl=300&sig=abc', Body: 'Receipt' });
    expect(calls[0]?.form?.getAll('MediaUrl')).toHaveLength(1);
  });

  it('location: Body = name, PersistentAction = geo:lat,long|label', async () => {
    const { adapter, calls } = setup();
    const location: RenderedOutbound = { kind: 'TWILIO_WHATSAPP', payload: { type: 'location', latitude: 19.076, longitude: 72.8777, name: 'Branch', label: 'Nariman Point' }, partIndexes: [0] };
    await adapter.send(customer, location, twConfig(), mediaResolver());
    expect(form(calls[0])).toMatchObject({ Body: 'Branch', PersistentAction: 'geo:19.076,72.8777|Nariman Point' });
  });

  it('end-to-end: render then send every payload of a multi-part reply', async () => {
    const { adapter, calls } = setup();
    const rendered = adapter.render(
      [
        { type: 'TEXT', text: 'Here is your **statement**:' },
        { type: 'DOCUMENT', media: { status: 'STORED', blobKey: 'outbound/stmt.pdf', mimeType: 'application/pdf' }, caption: 'September' },
      ],
      twConfig(),
    );
    for (const r of rendered) expect(await adapter.send(customer, r, twConfig(), mediaResolver())).toMatchObject({ ok: true });
    expect(calls.map((c) => [c.form?.get('Body') ?? null, c.form?.get('MediaUrl') ?? null])).toEqual([
      ['Here is your *statement*:', null],
      [null, 'https://blobs.ocso.example/outbound/stmt.pdf?ttl=900&sig=abc'],
      ['September', null],
    ]);
  });
});

describe('Twilio send — 24-hour window and Content Templates', () => {
  const stale = target({ identityValue: '+919812341208', lastInboundAt: new Date(NOW.getTime() - 25 * 3_600_000) });

  it('refuses free-form messages outside the window without calling Twilio (requiresTemplate)', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.send(stale, text(), twConfig(), mediaResolver())).toEqual({ ok: false, errorCode: 'outside_session_window', message: expect.any(String), retriable: false, requiresTemplate: true });
    expect(calls).toHaveLength(0);
  });

  it('sends a Content Template by ContentSid + ContentVariables outside the window', async () => {
    const { adapter, calls } = setup();
    const template = { contentSid: 'HXb5b62575e6e4ff6129ad7c8efe1f983e', variables: { '1': 'Priya', '2': '₹4,200' } };
    expect(await adapter.sendContentTemplate(stale, template, twConfig())).toMatchObject({ ok: true });
    expect(form(calls[0])).toEqual({
      To: 'whatsapp:+919812341208',
      From: SENDER,
      ContentSid: 'HXb5b62575e6e4ff6129ad7c8efe1f983e',
      ContentVariables: '{"1":"Priya","2":"₹4,200"}',
      StatusCallback: WEBHOOK_URL,
    });
    expect(adapter.renderTemplate(template)).toMatchObject({ kind: 'TWILIO_WHATSAPP', payload: { type: 'template' }, partIndexes: [] });
  });

  it('invalid templates are typed errors / failures', async () => {
    const { adapter, calls } = setup();
    expect(() => adapter.renderTemplate({ contentSid: 'payment_reminder' })).toThrowError(expect.objectContaining({ category: 'validation', code: 'invalid_twilio_template' }));
    expect(await adapter.sendContentTemplate(stale, { contentSid: 'HX1' }, twConfig())).toMatchObject({ ok: false, errorCode: 'invalid_template' });
    expect(calls).toHaveLength(0);
  });

  it('Twilio 63016 (window closed on their side) also signals requiresTemplate', async () => {
    const { adapter } = setup(() => twilioError(400, 63016, 'Failed to send freeform message because you are outside the allowed window.'));
    expect(await adapter.send(customer, text(), twConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'outside_session_window', retriable: false, requiresTemplate: true });
  });
});

describe('Twilio send — failures', () => {
  it.each([
    [429, 20429, 'rate_limited', true],
    [400, 63018, 'rate_limited', true],
    [401, 20003, 'auth_failed', false],
    [400, 63007, 'invalid_sender', false],
    [400, 21211, 'recipient_undeliverable', false],
    [400, 21610, 'recipient_opted_out', false],
    [400, 21617, 'invalid_request', false],
    [400, 63051, 'account_restricted', false],
    [500, 30008, 'provider_error', true],
    [400, 99999, 'provider_rejected', false],
  ])('HTTP %i / Twilio %i -> %s (retriable=%s)', async (status, code, errorCode, retriable) => {
    const { adapter } = setup(() => twilioError(status, code, 'Twilio says no'));
    const result = await adapter.send(customer, text(), twConfig(), mediaResolver());
    expect(result).toMatchObject({ ok: false, errorCode, retriable });
    expect(result.ok ? '' : result.message).toContain(`Twilio error ${code}`);
  });

  it('5xx without a body is retriable; network errors and timeouts are retriable', async () => {
    expect(await setup(() => new Response('', { status: 503 })).adapter.send(customer, text(), twConfig(), mediaResolver())).toMatchObject({ errorCode: 'provider_unavailable', retriable: true });
    expect(await setup(() => Promise.reject(new TypeError('fetch failed'))).adapter.send(customer, text(), twConfig(), mediaResolver())).toMatchObject({ errorCode: 'network_error', retriable: true });
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(await setup(() => Promise.reject(timeout)).adapter.send(customer, text(), twConfig(), mediaResolver())).toMatchObject({ errorCode: 'timeout', retriable: true });
  });

  it('a 2xx without a message SID is not retried (it would duplicate)', async () => {
    const { adapter } = setup(() => twilioJson({ status: 'queued' }, 201));
    expect(await adapter.send(customer, text(), twConfig(), mediaResolver())).toMatchObject({ ok: false, errorCode: 'provider_error', retriable: false });
  });

  it('never leaks the auth token or API key secret in failure messages', async () => {
    const { adapter } = setup(() => twilioError(401, 20003, `Authenticate with ${AUTH_TOKEN} and ${API_KEY_SECRET}`));
    const result = await adapter.send(customer, text(), twConfig({ apiKeySid: API_KEY_SID }, { apiKeySecret: API_KEY_SECRET }), mediaResolver());
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
    expect(JSON.stringify(result)).not.toContain(API_KEY_SECRET);
  });

  it('rejects wrong payloads, unaddressable recipients and broken config without calling Twilio', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.send(customer, { kind: 'WHATSAPP', payload: { type: 'text', body: 'x', previewUrl: false }, partIndexes: [] }, twConfig(), mediaResolver())).toMatchObject({ errorCode: 'invalid_payload' });
    expect(await adapter.send(target({ identityKind: 'webchat_visitor', identityValue: 'v1' }), text(), twConfig(), mediaResolver())).toMatchObject({ errorCode: 'invalid_recipient' });
    expect(await adapter.send(customer, text(), twConfig({ accountSid: 'nope' }), mediaResolver())).toMatchObject({ errorCode: 'invalid_channel_config' });
    const broken = mediaResolver({ signedUrl: () => Promise.reject(new Error('s3 down')) });
    const image: RenderedOutbound = { kind: 'TWILIO_WHATSAPP', payload: { type: 'media', mediaKind: 'IMAGE', blobKey: 'k', mimeType: 'image/jpeg' }, partIndexes: [0] };
    expect(await adapter.send(customer, image, twConfig(), broken)).toMatchObject({ errorCode: 'media_unavailable', retriable: true });
    expect(calls).toHaveLength(0);
  });

  it('addresses a BSUID-only customer as whatsapp:<BSUID>', async () => {
    const { adapter, calls } = setup();
    await adapter.send(target({ identityKind: 'whatsapp_bsuid', identityValue: 'IN.13491208655302741918' }), text(), twConfig(), mediaResolver());
    expect(calls[0]?.form?.get('To')).toBe('whatsapp:IN.13491208655302741918');
  });
});
