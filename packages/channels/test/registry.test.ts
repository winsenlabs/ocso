import { describe, expect, it } from 'vitest';
import {
  ChannelRegistry,
  createTwilioWhatsAppAdapter,
  createWebChatAdapter,
  createWhatsAppAdapter,
  NO_NETWORK,
  type ChannelAdapter,
  type ChannelKindDescriptor,
} from '../src/index.js';

/** A minimal third-party kind: what a new plugin (e.g. Telegram) supplies — no core change. */
function pluginAdapter(kind: string, over: Partial<ChannelKindDescriptor> = {}, extra: Partial<ChannelAdapter> = {}): ChannelAdapter {
  const descriptor: ChannelKindDescriptor = {
    kind,
    label: 'Telegram',
    description: 'Telegram bot',
    mark: { code: 'TG', name: 'Telegram' },
    settingsSchema: { type: 'object', properties: {} },
    secrets: [],
    setupSteps: ['Point the bot webhook at the URL above.'],
    inboundWebhook: true,
    webhookEvents: 'messages',
    embeddable: false,
    ...over,
  };
  const reject = () => Promise.reject(new Error('not used'));
  return {
    kind,
    describe: () => descriptor,
    capabilities: () => createWebChatAdapter().capabilities(),
    validateConfig: () => [],
    verifyRequest: () => ({ kind: 'verified' }),
    parseInbound: () => ({ messages: [], statuses: [], ignored: 0 }),
    fetchMedia: reject,
    render: () => [],
    send: reject,
    ...extra,
  };
}

const firstParty = () =>
  new ChannelRegistry().register(createTwilioWhatsAppAdapter()).register(createWhatsAppAdapter()).register(createWebChatAdapter());

describe('ChannelRegistry: kinds are open, validated at registration', () => {
  it('accepts any well-formed kind and derives its public paths from the descriptor', () => {
    const registry = firstParty().register(pluginAdapter('TELEGRAM'));
    expect(registry.has('TELEGRAM')).toBe(true);
    expect(registry.kindForWebhookSegment('telegram')).toBe('TELEGRAM');
    expect(registry.webhookPath('TELEGRAM', 'k/1')).toBe('/channels/telegram/k%2F1/webhook');
    expect(registry.describe('TELEGRAM')).toMatchObject({ kind: 'TELEGRAM', mark: { code: 'TG' }, connectionCheck: false, messageTemplates: false });
  });

  it('refuses malformed kinds, mismatched descriptors, duplicate kinds and segments', () => {
    expect(() => new ChannelRegistry().register(pluginAdapter('telegram'))).toThrow(/invalid channel kind/);
    expect(() => new ChannelRegistry().register(pluginAdapter('TELEGRAM', { kind: 'OTHER' }))).toThrow(/describes itself as OTHER/);
    expect(() => firstParty().register(createWebChatAdapter())).toThrow(/already registered/);
    expect(() => firstParty().register(pluginAdapter('TELEGRAM', { webhookSegment: 'whatsapp' }))).toThrow(/segment "whatsapp" already registered/);
    expect(() => firstParty().register(pluginAdapter('TELEGRAM', { mark: { code: 'TOO-LONG', name: 'x' } }))).toThrow(/invalid mark code/);
  });

  it('keeps embeddable and message-template claims honest', () => {
    expect(() => new ChannelRegistry().register(pluginAdapter('TELEGRAM', { embeddable: true }))).toThrow(/embed hooks/);
    expect(() => new ChannelRegistry().register(pluginAdapter('TELEGRAM', { templates: { reviewer: 'Telegram', placeholderScope: 'template' } }))).toThrow(/message templates/);
  });

  it('describes the first-party kinds with everything the web app renders', () => {
    const kinds = firstParty().describeAll();
    expect(kinds.map((k) => [k.kind, k.mark.code, k.embeddable, k.messageTemplates, k.connectionCheck])).toEqual([
      ['TWILIO_WHATSAPP', 'WA', false, true, true],
      ['WHATSAPP', 'WA', false, true, false],
      ['WEBCHAT', 'WB', true, false, false],
    ]);
    for (const k of kinds) {
      expect(k.label).not.toBe('');
      expect(k.mark.name).not.toBe('');
      if (k.inboundWebhook) expect(k.setupGuide.length).toBeGreaterThan(0);
    }
    expect(kinds.find((k) => k.kind === 'TWILIO_WHATSAPP')).toMatchObject({ identitySetting: { label: 'sender', keys: ['from', 'messagingServiceSid'] }, webhookEvents: 'messages, delivery statuses', templates: { reviewer: 'WhatsApp', placeholderScope: 'template' } });
  });

  it('serves the embed hooks only for embeddable kinds', () => {
    const registry = firstParty();
    expect(registry.embed('WEBCHAT')).not.toBeNull();
    expect(registry.embed('WHATSAPP')).toBeNull();
    expect(registry.embed('NOT_A_KIND')).toBeNull();
  });

  it('lets the owning adapter display its identities; others fall through to null', () => {
    const registry = firstParty();
    expect(registry.displayIdentity('webchat_visitor', 'v_0123456789abcdef8f2a')).toBe('web · sess 8f2a');
    expect(registry.displayIdentity('webchat_customer_ref', 'cust_1')).toBeNull();
    expect(registry.displayIdentity('whatsapp_phone', '+919812341208')).toBeNull();
  });
});

describe('adapter egress', () => {
  it('has no network unless the composition root injects a fetch (never the global fetch)', async () => {
    await expect(NO_NETWORK('https://api.twilio.com/')).rejects.toThrow(/no network access/);
    const { checks } = await createTwilioWhatsAppAdapter().checkConnection({
      id: 'c1',
      kind: 'TWILIO_WHATSAPP',
      name: 'x',
      settings: { accountSid: 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90', from: 'whatsapp:+14155238886', statusCallback: false },
      secrets: { authToken: '3f9c2b7a1e8d4c6b0a5f9e2d7c1b8a46' },
    });
    expect(checks[0]).toMatchObject({ ok: false, detail: 'could not reach Twilio' });
  });
});
