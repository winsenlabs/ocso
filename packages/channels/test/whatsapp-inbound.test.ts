import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InteractionPart } from '@ocso/domain';
import { createWhatsAppAdapter, type InboundEnvelope } from '../src/index.js';
import { fixture, NOW, PHONE_NUMBER_ID, postRequest, WABA_ID, waConfig } from './helpers/whatsapp.js';

const adapter = createWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')), now: () => NOW });
const config = waConfig();
const parse = (name: string, cfg = config): InboundEnvelope => adapter.parseInbound(postRequest(fixture(name)), cfg);
const onlyMessage = (name: string) => {
  const envelope = parse(name);
  expect(envelope.messages).toHaveLength(1);
  const [message] = envelope.messages;
  if (!message) throw new Error('no message');
  return message;
};
const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');

describe('WhatsApp inbound normalization — every message type', () => {
  it('text', () => {
    const message = onlyMessage('text');
    expect(message).toMatchObject({
      externalMessageId: 'wamid.HBgLMTY1MDU1NTEyMzQVAgASGBQzQTdCMUZGQjYyNjYwREYzRTRCQwA=',
      channelAccountId: PHONE_NUMBER_ID,
      profileName: 'Sheena Nelson',
      receivedAt: new Date(1758535200 * 1000),
      parts: [{ type: 'TEXT', text: 'Hi, I was charged twice for my card last week.' }],
    });
  });

  it('image: PENDING media referencing the WhatsApp media id, hex sha256, caption', () => {
    const [part] = onlyMessage('image').parts;
    expect(part).toEqual({
      type: 'IMAGE',
      caption: 'Receipt from the ATM',
      media: {
        status: 'PENDING',
        mimeType: 'image/jpeg',
        sha256: sha256Hex('fake-jpeg-bytes'),
        source: { channel: 'WHATSAPP', externalId: '1003383421387256' },
      },
    });
  });

  it('audio: voice note flag and codec-qualified MIME type', () => {
    const [part] = onlyMessage('audio-voice').parts;
    expect(part).toMatchObject({ type: 'AUDIO', voiceNote: true, media: { mimeType: 'audio/ogg; codecs=opus', status: 'PENDING' } });
  });

  it('video with caption', () => {
    expect(onlyMessage('video').parts[0]).toMatchObject({
      type: 'VIDEO',
      caption: 'The card reader error',
      media: { mimeType: 'video/mp4', source: { externalId: '1422567812345678' } },
    });
  });

  it('document with filename and caption', () => {
    expect(onlyMessage('document').parts[0]).toMatchObject({
      type: 'DOCUMENT',
      caption: 'March statement',
      media: { filename: 'statement-march-2026.pdf', mimeType: 'application/pdf', sha256: sha256Hex('fake-pdf-bytes') },
    });
  });

  it('sticker becomes an IMAGE part', () => {
    expect(onlyMessage('sticker').parts[0]).toMatchObject({ type: 'IMAGE', media: { mimeType: 'image/webp', status: 'PENDING' } });
  });

  it('location', () => {
    expect(onlyMessage('location').parts[0]).toEqual({
      type: 'LOCATION',
      latitude: 19.076,
      longitude: 72.8777,
      name: 'Meridian Bank, Nariman Point',
      address: 'Nariman Point, Mumbai 400021',
    });
  });

  it('contacts are kept as a CONTACT part (not dropped)', () => {
    expect(onlyMessage('contacts').parts[0]).toEqual({
      type: 'CONTACT',
      contacts: [
        {
          name: 'Barbara J. Johnson',
          phones: ['+1 (415) 555-0829'],
          emails: ['barbara@example.com'],
          organization: 'Example Corp',
        },
        { name: 'Ravi Kumar', phones: ['919812345678'], emails: [] },
      ],
    });
  });

  it('interactive button_reply -> STRUCTURED with fallback text and reply context', () => {
    const message = onlyMessage('interactive-button-reply');
    expect(message.replyToExternalId).toBe('wamid.HBgLMTY1MDU1NTEyMzQVAgARGBJBMkU3QjYwMDhDMUQ5NTM4RDIA');
    expect(message.parts[0]).toEqual({
      type: 'STRUCTURED',
      schema: 'button_reply',
      data: { id: 'block-card', title: 'Block my card', source: 'interactive' },
      fallbackText: 'Block my card',
    });
  });

  it('interactive list_reply', () => {
    expect(onlyMessage('interactive-list-reply').parts[0]).toEqual({
      type: 'STRUCTURED',
      schema: 'list_reply',
      data: { id: 'dispute-txn-8841', title: 'Dispute a charge', description: 'TXN-8841 · ₹12,480 · 14 Sep' },
      fallbackText: 'Dispute a charge — TXN-8841 · ₹12,480 · 14 Sep',
    });
  });

  it('interactive nfm_reply (WhatsApp Flow) -> STRUCTURED flow_reply with parsed response', () => {
    expect(onlyMessage('interactive-flow-reply').parts[0]).toMatchObject({
      type: 'STRUCTURED',
      schema: 'flow_reply',
      data: { name: 'flow', response: { flow_token: 'kyc-7731', pan: 'ABCDE1234F' } },
    });
  });

  it('legacy template quick-reply button', () => {
    expect(onlyMessage('button-template-reply').parts[0]).toEqual({
      type: 'STRUCTURED',
      schema: 'button_reply',
      data: { id: 'PAY_NOW', title: 'Pay now', source: 'template' },
      fallbackText: 'Pay now',
    });
  });

  it('reaction added', () => {
    const message = onlyMessage('reaction');
    expect(message.parts[0]).toEqual({
      type: 'STRUCTURED',
      schema: 'reaction',
      data: { messageId: 'wamid.HBgLMTY1MDU1NTEyMzQVAgARGBJFNkMxRkE0NDJBNUJEOTdDQjYA', emoji: '👍', action: 'added' },
      fallbackText: 'Reacted 👍 to a message',
    });
  });

  it('reaction removed (emoji omitted) is reported as a removal, not an add', () => {
    expect(onlyMessage('reaction-removed').parts[0]).toMatchObject({
      schema: 'reaction',
      data: { emoji: null, action: 'removed' },
      fallbackText: 'Removed a reaction',
    });
  });

  it('reaction removed with an empty emoji string is also a removal', () => {
    const raw = JSON.parse(fixture('reaction').toString('utf8'));
    raw.entry[0].changes[0].value.messages[0].reaction.emoji = '';
    const envelope = adapter.parseInbound(postRequest(Buffer.from(JSON.stringify(raw))), config);
    expect(envelope.messages[0]?.parts[0]).toMatchObject({ data: { action: 'removed', emoji: null } });
  });

  it.each(['order', 'unsupported'])('%s messages are counted as ignored', (name) => {
    const envelope = parse(name);
    expect(envelope.messages).toEqual([]);
    expect(envelope.ignored).toBe(1);
  });

  it('click-to-WhatsApp referral is appended as a STRUCTURED referral part', () => {
    const message = onlyMessage('referral');
    expect(message.parts).toHaveLength(2);
    expect(message.parts[1]).toMatchObject({
      type: 'STRUCTURED',
      schema: 'referral',
      data: { sourceType: 'ad', headline: '0% EMI on Meridian cards', sourceId: '120212345678901234' },
      fallbackText: '[arrived via 0% EMI on Meridian cards]',
    });
  });

  it('every produced part satisfies the canonical domain schema', () => {
    const names = ['text', 'image', 'audio-voice', 'video', 'document', 'sticker', 'location', 'contacts'];
    const more = ['interactive-button-reply', 'interactive-list-reply', 'interactive-flow-reply', 'button-template-reply'];
    for (const name of [...names, ...more, 'reaction', 'reaction-removed', 'referral']) {
      for (const part of onlyMessage(name).parts) expect(InteractionPart.safeParse(part).success, name).toBe(true);
    }
  });
});

describe('WhatsApp identity', () => {
  it('prefers the BSUID and keeps the phone (E.164) as an alternate identity', () => {
    expect(onlyMessage('text')).toMatchObject({
      identityKind: 'whatsapp_bsuid',
      identityValue: 'US.13491208655302741918',
      alternateIdentities: [{ kind: 'whatsapp_phone', value: '+16505551234' }],
    });
  });

  it('falls back to the phone when no BSUID is present', () => {
    const raw = JSON.parse(fixture('text').toString('utf8'));
    delete raw.entry[0].changes[0].value.messages[0].from_user_id;
    delete raw.entry[0].changes[0].value.contacts[0].user_id;
    const [message] = adapter.parseInbound(postRequest(Buffer.from(JSON.stringify(raw))), config).messages;
    expect(message).toMatchObject({ identityKind: 'whatsapp_phone', identityValue: '+16505551234', alternateIdentities: [] });
  });

  it('handles username users with only a (parent-style) BSUID and no phone', () => {
    expect(onlyMessage('bsuid-only')).toMatchObject({
      identityKind: 'whatsapp_bsuid',
      identityValue: 'US.ENT.771234567890123456',
      alternateIdentities: [],
      profileName: '@sheena.n',
    });
  });

  it('drops messages with no usable sender identity', () => {
    const raw = JSON.parse(fixture('text').toString('utf8'));
    const value = raw.entry[0].changes[0].value;
    delete value.messages[0].from;
    delete value.messages[0].from_user_id;
    value.contacts = [];
    const envelope = adapter.parseInbound(postRequest(Buffer.from(JSON.stringify(raw))), config);
    expect(envelope).toMatchObject({ messages: [], ignored: 1 });
  });

  it('matches each message to its own contact in a batch', () => {
    const envelope = parse('multi-entry');
    expect(envelope.messages.map((m) => [m.identityValue, m.profileName])).toEqual([
      ['US.13491208655302741918', 'Sheena Nelson'],
      ['IN.88123456789012345678', 'Arjun Mehta'],
      ['+919000000001', 'Meera Iyer'],
    ]);
  });

  it('surfaces BSUID rotation (user_id_update) as an identity update', () => {
    const envelope = parse('user-id-update');
    expect(envelope.identityUpdates).toEqual([
      {
        identityKind: 'whatsapp_bsuid',
        previousValue: 'US.13491208655302741918',
        currentValue: 'US.99887766554433221100',
        alternateIdentities: [{ kind: 'whatsapp_phone', value: '+16505559999' }],
        channelAccountId: PHONE_NUMBER_ID,
        occurredAt: new Date(1758535200 * 1000),
      },
    ]);
    expect(envelope.messages).toEqual([]);
  });

  it('surfaces a system user_changed_number message as a phone identity update', () => {
    const envelope = parse('system-changed-number');
    expect(envelope.messages).toEqual([]);
    expect(envelope.identityUpdates).toMatchObject([
      { identityKind: 'whatsapp_phone', previousValue: '+16505551234', currentValue: '+16505559999' },
    ]);
  });
});

describe('WhatsApp delivery statuses', () => {
  it('maps sent/delivered/read/failed with error code and title', () => {
    const envelope = parse('statuses');
    expect(envelope.messages).toEqual([]);
    expect(envelope.statuses.map((s) => s.status)).toEqual(['SENT', 'DELIVERED', 'READ', 'FAILED']);
    expect(envelope.statuses[0]).toMatchObject({
      externalMessageId: 'wamid.HBgLMTY1MDU1NTEyMzQVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA',
      recipientId: 'US.13491208655302741918',
      occurredAt: new Date(1758535260 * 1000),
    });
    expect(envelope.statuses[2]?.recipientId).toBe('+16505551234');
    expect(envelope.statuses[3]).toMatchObject({
      status: 'FAILED',
      errorCode: '131049',
      errorTitle: 'This message was not delivered to maintain healthy ecosystem engagement.',
    });
  });

  it('ignores unknown status values', () => {
    const raw = JSON.parse(fixture('statuses').toString('utf8'));
    raw.entry[0].changes[0].value.statuses[0].status = 'deleted';
    const envelope = adapter.parseInbound(postRequest(Buffer.from(JSON.stringify(raw))), config);
    expect(envelope.statuses).toHaveLength(3);
    expect(envelope.ignored).toBe(1);
  });
});

describe('WhatsApp batching and idempotency', () => {
  it('handles multiple entries and changes, ignoring unrelated fields', () => {
    const envelope = parse('multi-entry');
    expect(envelope.messages.map((m) => m.externalMessageId)).toEqual(['wamid.MULTI.A1', 'wamid.MULTI.B1', 'wamid.MULTI.C1']);
    expect(envelope.messages.map((m) => m.channelAccountId)).toEqual([PHONE_NUMBER_ID, PHONE_NUMBER_ID, '109999999999999']);
    expect(envelope.statuses).toEqual([expect.objectContaining({ externalMessageId: 'wamid.OUT.1', status: 'DELIVERED' })]);
    // The message_template_status_update change is a template review result, not an ignored entry.
    expect(envelope.templateUpdates).toEqual([{ templateId: '12345', name: 'payment_reminder', language: 'en_US', status: 'APPROVED', reason: null, occurredAt: NOW }]);
    expect(envelope.ignored).toBe(0);
  });

  it('a redelivered webhook yields the same idempotency key (wamid)', () => {
    const first = parse('image');
    const second = parse('image');
    expect(second.messages[0]?.externalMessageId).toBe(first.messages[0]?.externalMessageId);
    expect(second).toEqual(first);
  });

  it('ignores entries for another WhatsApp Business Account when one is configured', () => {
    const scoped = waConfig({ businessAccountId: '999999999999' });
    expect(parse('text', scoped)).toMatchObject({ messages: [], ignored: 1 });
    expect(parse('text', waConfig({ businessAccountId: WABA_ID })).messages).toHaveLength(1);
  });

  it('one malformed message does not drop the rest of the batch', () => {
    const raw = JSON.parse(fixture('multi-entry').toString('utf8'));
    raw.entry[0].changes[0].value.messages[0] = { type: 'text' }; // no id
    const envelope = adapter.parseInbound(postRequest(Buffer.from(JSON.stringify(raw))), config);
    expect(envelope.messages.map((m) => m.externalMessageId)).toEqual(['wamid.MULTI.B1', 'wamid.MULTI.C1']);
    expect(envelope.ignored).toBe(1);
  });

  it('non-WhatsApp objects are ignored, invalid JSON is a typed validation error', () => {
    const other = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));
    expect(adapter.parseInbound(postRequest(other), config)).toMatchObject({ messages: [], ignored: 1 });
    expect(() => adapter.parseInbound(postRequest(Buffer.from('{not json')), config)).toThrowError(
      expect.objectContaining({ category: 'validation', code: 'whatsapp_invalid_json' }),
    );
    expect(() => adapter.parseInbound(postRequest(Buffer.from('{"entry":1}')), config)).toThrowError(
      expect.objectContaining({ code: 'whatsapp_invalid_envelope' }),
    );
  });
});
