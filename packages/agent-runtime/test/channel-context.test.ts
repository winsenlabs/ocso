import { describe, expect, it } from 'vitest';
import { ChannelRegistry, createTwilioWhatsAppAdapter, createWebChatAdapter } from '@ocso/channels';
import { basicChannelContext, channelContextFrom } from '../src/context/channel-context.js';

const channel = (kind: string, settings: Record<string, unknown> = {}) => ({ id: 'c1', kind, name: 'Support', settings });

describe('channel context for the prompt', () => {
  const resolve = channelContextFrom(new ChannelRegistry().register(createTwilioWhatsAppAdapter()).register(createWebChatAdapter()));

  it('carries the adapter-declared limits, never a per-kind default', () => {
    expect(resolve(channel('TWILIO_WHATSAPP'))).toEqual({
      kind: 'TWILIO_WHATSAPP',
      label: 'Support',
      limits: { maxTextLength: 1600, markdown: 'basic', outboundParts: expect.arrayContaining(['TEXT', 'IMAGE', 'DOCUMENT']) },
    });
    expect(resolve(channel('WEBCHAT'))).toMatchObject({ limits: { maxTextLength: 8000, markdown: 'commonmark' } });
  });

  it('falls back to name and kind for kinds without an adapter', () => {
    expect(resolve(channel('RETIRED_KIND'))).toEqual({ kind: 'RETIRED_KIND', label: 'Support' });
    expect(basicChannelContext(channel('WEBCHAT'))).toEqual({ kind: 'WEBCHAT', label: 'Support' });
  });
});
