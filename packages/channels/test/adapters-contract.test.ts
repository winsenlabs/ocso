import { describe, expect, it } from 'vitest';
import {
  ChannelRegistry,
  createMsTeamsAdapter,
  createSlackChannelAdapter,
  createTwilioWhatsAppAdapter,
  createWebChatAdapter,
  createWhatsAppAdapter,
  customerSafeParts,
  withinSessionWindow,
  type ChannelAdapter,
} from '../src/index.js';
import { slConfig } from './helpers/slack.js';
import { mtConfig } from './helpers/teams.js';
import { twConfig } from './helpers/twilio.js';
import { wcConfig } from './helpers/webchat.js';
import { waConfig } from './helpers/whatsapp.js';

const adapters: Array<[ChannelAdapter, ReturnType<typeof waConfig>]> = [
  [createWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')) }), waConfig()],
  [createWebChatAdapter(), wcConfig()],
  [createTwilioWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')) }), twConfig()],
  [createSlackChannelAdapter({ fetch: () => Promise.reject(new Error('offline')) }), slConfig()],
  [createMsTeamsAdapter({ fetch: () => Promise.reject(new Error('offline')) }), mtConfig()],
];

describe('channel adapters satisfy the shared contract', () => {
  it('register by kind in the channel registry', () => {
    const registry = new ChannelRegistry();
    for (const [adapter] of adapters) registry.register(adapter);
    expect(registry.kinds()).toEqual(['WHATSAPP', 'WEBCHAT', 'TWILIO_WHATSAPP', 'SLACK', 'MS_TEAMS']);
    expect(registry.get('WHATSAPP').kind).toBe('WHATSAPP');
  });

  it.each(adapters)('%o never declares TOOL_RESULT as renderable and has consistent limits', (adapter, config) => {
    const caps = adapter.capabilities(config);
    expect(caps.outboundParts).not.toContain('TOOL_RESULT');
    expect(caps.inboundParts).not.toContain('TOOL_RESULT');
    for (const kind of ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'] as const) {
      if (caps.allowedMimeTypes[kind].length) expect(caps.maxMediaBytes[kind]).toBeGreaterThan(0);
    }
    expect(customerSafeParts([{ type: 'TOOL_RESULT', toolCallId: 'c', toolName: 't', status: 'FAILED', summary: {} }], caps).parts).toEqual([]);
  });

  it.each(adapters)('%o accepts its own valid config', (adapter, config) => {
    expect(adapter.validateConfig(config.settings, config.secrets)).toEqual([]);
  });

  it('WhatsApp (Meta and Twilio) enforces a 24h window; web chat has none', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    const old = new Date(now.getTime() - 48 * 3_600_000);
    const [[whatsapp, waCfg], [webchat, wcCfg], [twilio, twCfg]] = adapters as [(typeof adapters)[number], (typeof adapters)[number], (typeof adapters)[number]];
    expect(withinSessionWindow(whatsapp.capabilities(waCfg), old, now)).toBe(false);
    expect(withinSessionWindow(twilio.capabilities(twCfg), old, now)).toBe(false);
    expect(withinSessionWindow(webchat.capabilities(wcCfg), null, now)).toBe(true);
  });

  it('both WhatsApp integrations use the same phone identity kind, so a customer is one customer', () => {
    const [[whatsapp, waCfg], , [twilio, twCfg]] = adapters as [(typeof adapters)[number], (typeof adapters)[number], (typeof adapters)[number]];
    expect(whatsapp.capabilities(waCfg).identityKinds).toContain('whatsapp_phone');
    expect(twilio.capabilities(twCfg).identityKinds?.[0]).toBe('whatsapp_phone');
  });
});
