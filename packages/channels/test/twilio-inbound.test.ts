import { describe, expect, it } from 'vitest';
import { createTwilioWhatsAppAdapter, type InboundEnvelope } from '../src/index.js';
import { ACCOUNT_SID, formBody, NOW, twConfig, twFixture, webhookRequest } from './helpers/twilio.js';

const adapter = createTwilioWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')), now: () => NOW });
const parse = (params: Record<string, string>): InboundEnvelope => adapter.parseInbound(webhookRequest(params), twConfig());
const only = (params: Record<string, string>) => {
  const envelope = parse(params);
  expect(envelope.messages).toHaveLength(1);
  return envelope.messages[0]!;
};
const mediaUrl = (params: Record<string, string>) => params['MediaUrl0'];

describe('Twilio inbound messages', () => {
  it('normalizes a text message: MessageSid idempotency key, whatsapp_phone identity, profile, business number', () => {
    expect(parse(twFixture('text'))).toEqual({
      messages: [
        {
          externalMessageId: 'SM2f6c1e0b9a8d7c6b5a4f3e2d1c0b9a8f',
          identityKind: 'whatsapp_phone',
          identityValue: '+919812341208',
          alternateIdentities: [],
          profileName: 'Priya Deshmukh',
          channelAccountId: 'whatsapp:+14155238886',
          receivedAt: NOW,
          parts: [{ type: 'TEXT', text: 'My EMI was debited twice this month & I need a refund' }],
          replyToExternalId: undefined,
        },
      ],
      statuses: [],
      ignored: 0,
    });
  });

  it('the same webhook delivered twice yields the same idempotency key (ingress dedupes on it)', () => {
    const first = only(twFixture('text'));
    const again = only(twFixture('text'));
    expect(again.externalMessageId).toBe(first.externalMessageId);
  });

  it('image with caption: a PENDING media reference to the Twilio media URL, caption from Body (no duplicate text)', () => {
    const params = twFixture('image-caption');
    expect(only(params).parts).toEqual([
      {
        type: 'IMAGE',
        media: { status: 'PENDING', mimeType: 'image/jpeg', source: { channel: 'TWILIO_WHATSAPP', externalId: mediaUrl(params) } },
        caption: 'Receipt attached',
      },
    ]);
  });

  it('audio (voice note), documents and vCards become AUDIO / DOCUMENT parts', () => {
    expect(only(twFixture('audio-voice')).parts).toEqual([{ type: 'AUDIO', media: expect.objectContaining({ mimeType: 'audio/ogg', status: 'PENDING' }) }]);
    expect(only(twFixture('document')).parts).toEqual([
      { type: 'DOCUMENT', media: expect.objectContaining({ mimeType: 'application/pdf' }), caption: 'statement.pdf' },
    ]);
    expect(only(twFixture('vcard')).parts).toEqual([{ type: 'DOCUMENT', media: expect.objectContaining({ mimeType: 'text/vcard', filename: 'contact.vcf' }) }]);
  });

  it('audio with text keeps the text as its own part (WhatsApp audio has no caption)', () => {
    expect(only(twFixture('audio-voice', { Body: 'listen to this' })).parts.map((p) => p.type)).toEqual(['AUDIO', 'TEXT']);
  });

  it('several media items become several parts; the caption goes on the first captionable one', () => {
    const params = twFixture('image-caption', {
      NumMedia: '2',
      MediaContentType1: 'image/png',
      MediaUrl1: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/MM7d4b1c2a3e5f60718293a4b5c6d7e8f9/Media/ME9f8e7d6c5b4a39281706f5e4d3c2b1a0`,
    });
    const parts = only(params).parts;
    expect(parts.map((p) => [p.type, 'caption' in p ? p.caption : undefined])).toEqual([
      ['IMAGE', 'Receipt attached'],
      ['IMAGE', undefined],
    ]);
  });

  it('location: Latitude/Longitude with Label as name and Address', () => {
    expect(only(twFixture('location')).parts).toEqual([
      { type: 'LOCATION', latitude: 19.076, longitude: 72.8777, name: 'Meridian Bank branch', address: 'Nariman Point, Mumbai 400021' },
    ]);
    expect(parse(twFixture('location', { Latitude: '191', Body: '' })).ignored).toBe(1);
  });

  it('quick-reply button tap: STRUCTURED button_reply (same schema as Meta) and reply context', () => {
    const message = only(twFixture('button-reply'));
    expect(message.parts).toEqual([
      {
        type: 'STRUCTURED',
        schema: 'button_reply',
        data: { id: 'block_card_yes', title: 'Yes, block it', source: 'content_template', buttonType: 'reply' },
        fallbackText: 'Yes, block it',
      },
    ]);
    expect(message.replyToExternalId).toBe('SM9f8e7d6c5b4a39281706f5e4d3c2b1a0');
  });

  it('click-to-WhatsApp referral is appended as a STRUCTURED referral part', () => {
    const parts = only(twFixture('referral')).parts;
    expect(parts.map((p) => p.type)).toEqual(['TEXT', 'STRUCTURED']);
    expect(parts[1]).toMatchObject({ schema: 'referral', data: { sourceType: 'ad', headline: 'Travel card, zero forex markup', ctwaClid: expect.any(String) } });
  });

  it('keeps the 2026 BSUID (ExternalUserId) as a whatsapp_bsuid alternate; BSUID-only senders use it as primary', () => {
    expect(only(twFixture('bsuid-with-phone'))).toMatchObject({
      identityKind: 'whatsapp_phone',
      identityValue: '+919812341208',
      alternateIdentities: [{ kind: 'whatsapp_bsuid', value: 'IN.13491208655302741918' }],
    });
    expect(only(twFixture('bsuid-only'))).toMatchObject({ identityKind: 'whatsapp_bsuid', identityValue: 'IN.13491208655302741918', alternateIdentities: [] });
  });

  it('ignores SMS, other accounts, malformed SIDs and empty messages', () => {
    expect(parse(twFixture('sms'))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(twFixture('text', { AccountSid: 'AC00000000000000000000000000000000' }))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(twFixture('text', { MessageSid: '../etc', SmsMessageSid: undefined }))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(twFixture('text', { Body: '   ' }))).toMatchObject({ messages: [], ignored: 1 });
  });

  it('refuses an oversized body with a typed validation error', () => {
    const req = { ...webhookRequest(twFixture('text')), rawBody: formBody({ Body: 'x'.repeat(300 * 1024) }) };
    expect(() => adapter.parseInbound(req, twConfig())).toThrowError(expect.objectContaining({ category: 'validation', code: 'twilio_body_too_large' }));
  });
});

describe('Twilio status callbacks', () => {
  it.each([
    ['status-delivered', 'DELIVERED'],
    ['status-read', 'READ'],
  ])('%s -> %s', (name, status) => {
    expect(parse(twFixture(name))).toEqual({
      messages: [],
      statuses: [{ externalMessageId: 'SMa3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8', status, occurredAt: NOW, recipientId: '+919812341208', errorCode: undefined, errorTitle: undefined }],
      ignored: 0,
    });
  });

  it('undelivered is FAILED with the Twilio error code and channel detail', () => {
    expect(parse(twFixture('status-undelivered')).statuses).toEqual([
      expect.objectContaining({ status: 'FAILED', errorCode: '63016', errorTitle: expect.stringContaining('outside the allowed window') }),
    ]);
  });

  it('pre-send states are ignored, not mistaken for inbound messages', () => {
    expect(parse(twFixture('status-queued'))).toEqual({ messages: [], statuses: [], ignored: 1 });
  });
});

describe('Twilio webhook acknowledgement', () => {
  it('answers with empty TwiML so Twilio sends no auto-reply', () => {
    expect(adapter.webhookAcknowledgement()).toEqual({ status: 200, contentType: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8"?><Response/>' });
  });
});
