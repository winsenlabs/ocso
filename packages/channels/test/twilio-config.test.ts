import { describe, expect, it } from 'vitest';
import { ChannelRegistry, createTwilioWhatsAppAdapter, createWebChatAdapter, createWhatsAppAdapter, TWILIO_WHATSAPP_DESCRIPTOR } from '../src/index.js';
import { ACCOUNT_SID, API, API_KEY_SECRET, API_KEY_SID, AUTH_TOKEN, basic, MESSAGING_SERVICE_SID, SENDER, twConfig, twilioError, twilioFetch, twilioJson } from './helpers/twilio.js';

const offline = createTwilioWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')) });

describe('Twilio WhatsApp configuration', () => {
  it('accepts a sender or a Messaging Service (exactly one); normalizes +E.164 to whatsapp:+E.164', () => {
    expect(offline.validateConfig({ accountSid: ACCOUNT_SID, from: SENDER }, { authToken: AUTH_TOKEN })).toEqual([]);
    expect(offline.validateConfig({ accountSid: ACCOUNT_SID, from: '+14155238886' }, { authToken: AUTH_TOKEN })).toEqual([]);
    expect(offline.validateConfig({ accountSid: ACCOUNT_SID, messagingServiceSid: MESSAGING_SERVICE_SID }, { authToken: AUTH_TOKEN })).toEqual([]);
    expect(offline.validateConfig({ accountSid: ACCOUNT_SID }, { authToken: AUTH_TOKEN })).toEqual([expect.stringMatching(/^settings\.from: set either/)]);
    expect(offline.validateConfig({ accountSid: ACCOUNT_SID, from: SENDER, messagingServiceSid: MESSAGING_SERVICE_SID }, { authToken: AUTH_TOKEN })).toHaveLength(1);
  });

  it('reports malformed SIDs, senders and base URLs field by field', () => {
    const problems = offline.validateConfig({ accountSid: 'AC123', from: 'whatsapp:14155238886', apiBaseUrl: 'http://api.twilio.com' }, { authToken: AUTH_TOKEN });
    expect(problems).toEqual([
      expect.stringMatching(/^settings\.accountSid: must be a Twilio Account SID/),
      expect.stringMatching(/^settings\.from: must be a WhatsApp sender/),
      expect.stringMatching(/^settings\.apiBaseUrl: must use https/),
    ]);
  });

  it('requires the auth token (webhook signatures) and the API key secret when an API key SID is set; never echoes values', () => {
    expect(offline.validateConfig({ accountSid: ACCOUNT_SID, from: SENDER }, {})).toEqual(['secrets.authToken: required']);
    const problems = offline.validateConfig({ accountSid: ACCOUNT_SID, from: SENDER, apiKeySid: API_KEY_SID }, { authToken: 'short token' });
    expect(problems).toEqual(['secrets.authToken: must not contain whitespace', 'secrets.apiKeySecret: required']);
    expect(JSON.stringify(problems)).not.toContain('short token');
  });

  it('describes itself for the Add channel form as "WhatsApp — Twilio" with its webhook segment', () => {
    expect(TWILIO_WHATSAPP_DESCRIPTOR).toMatchObject({ kind: 'TWILIO_WHATSAPP', label: 'WhatsApp — Twilio', inboundWebhook: true, webhookSegment: 'twilio-whatsapp', embeddable: false });
    const properties = (TWILIO_WHATSAPP_DESCRIPTOR.settingsSchema['properties'] ?? {}) as Record<string, { title?: string }>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['accountSid', 'from', 'messagingServiceSid', 'apiKeySid', 'statusCallback', 'apiBaseUrl']));
    expect(properties['accountSid']?.title).toBe('Account SID');
    expect(TWILIO_WHATSAPP_DESCRIPTOR.secrets.map((s) => [s.key, s.required])).toEqual([
      ['authToken', true],
      ['apiKeySecret', false],
    ]);
  });

  it('the registry derives each webhook kind’s public path from its descriptor', () => {
    const registry = new ChannelRegistry().register(offline).register(createWhatsAppAdapter()).register(createWebChatAdapter());
    expect(registry.kindForWebhookSegment('twilio-whatsapp')).toBe('TWILIO_WHATSAPP');
    expect(registry.kindForWebhookSegment('whatsapp')).toBe('WHATSAPP');
    expect(registry.kindForWebhookSegment('webchat')).toBeNull();
    expect(registry.publicPath('TWILIO_WHATSAPP', 'k1')).toBe('/channels/twilio-whatsapp/k1/webhook');
    expect(registry.publicPath('WHATSAPP', 'k2')).toBe('/channels/whatsapp/k2/webhook');
    expect(registry.publicPath('WEBCHAT', 'k3')).toBe('/webchat/k3');
    expect(registry.publicPath('SMS', 'k4')).toBeNull();
    expect(registry.webhookUrl('TWILIO_WHATSAPP', 'k1', 'https://ocso.example.com/ignored/path')).toBe('https://ocso.example.com/channels/twilio-whatsapp/k1/webhook');
    expect(registry.has('TWILIO_WHATSAPP')).toBe(true);
    expect(registry.has('NOT_A_KIND')).toBe(false);
  });
});

describe('Twilio connection check (read-only)', () => {
  const account = twilioJson({ sid: ACCOUNT_SID, friendly_name: 'Meridian Bank', status: 'active', type: 'Full' });

  it('fetches the account (GET, never a message) and reports the status-callback prerequisite', async () => {
    const { fetch, calls } = twilioFetch(() => account.clone());
    const result = await createTwilioWhatsAppAdapter({ fetch }).checkConnection(twConfig());
    expect(result).toEqual({
      ok: true,
      checks: [
        { name: 'Account SID + auth token', ok: true, detail: '"Meridian Bank" is active' },
        { name: 'Delivery statuses', ok: true, detail: expect.any(String) },
      ],
    });
    expect(calls.map((c) => [c.method, c.url, c.headers.get('authorization')])).toEqual([['GET', `${API}.json`, basic(ACCOUNT_SID, AUTH_TOKEN)]]);
  });

  it('with an API key, checks both the key and the webhook-signing auth token', async () => {
    const { fetch, calls } = twilioFetch((_url, call) => (call.headers.get('authorization') === basic(ACCOUNT_SID, AUTH_TOKEN) ? twilioError(401, 20003, 'Authenticate') : account.clone()));
    const result = await createTwilioWhatsAppAdapter({ fetch }).checkConnection(twConfig({ apiKeySid: API_KEY_SID, statusCallback: false }, { apiKeySecret: API_KEY_SECRET }));
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { name: 'API key', ok: true, detail: '"Meridian Bank" is active' },
      { name: 'Auth token (signs webhooks)', ok: false, detail: 'Twilio rejected the credentials (HTTP 401)' },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('flags suspended accounts, unreachable Twilio, missing https callbacks and bad config — without secrets', async () => {
    const suspended = twilioFetch(() => twilioJson({ friendly_name: 'Meridian Bank', status: 'suspended' }));
    expect((await createTwilioWhatsAppAdapter({ fetch: suspended.fetch }).checkConnection(twConfig({ statusCallback: false }))).checks[0]).toMatchObject({ ok: false, detail: '"Meridian Bank" is suspended' });
    const down = twilioFetch(() => Promise.reject(new TypeError('fetch failed')) as never);
    const result = await createTwilioWhatsAppAdapter({ fetch: down.fetch }).checkConnection(twConfig({}, {}, null));
    expect(result.checks).toEqual([
      { name: 'Account SID + auth token', ok: false, detail: 'could not reach Twilio' },
      { name: 'Delivery statuses', ok: false, detail: expect.stringContaining('https') },
    ]);
    const invalid = await offline.checkConnection(twConfig({ accountSid: 'bad' }));
    expect(invalid).toMatchObject({ ok: false, checks: [{ name: 'Configuration', ok: false }] });
    expect(JSON.stringify(invalid)).not.toContain(AUTH_TOKEN);
  });
});
