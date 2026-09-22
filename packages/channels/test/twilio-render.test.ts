import { describe, expect, it } from 'vitest';
import type { InteractionPart } from '@ocso/domain';
import { createTwilioWhatsAppAdapter, TWILIO_BODY_LIMIT } from '../src/index.js';
import { twConfig } from './helpers/twilio.js';

const adapter = createTwilioWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')) });
const render = (parts: InteractionPart[]) => adapter.render(parts, twConfig());
const payloads = (parts: InteractionPart[]) => render(parts).map((r) => r.payload);
const stored = (mimeType: string, blobKey = 'outbound/file') => ({ status: 'STORED' as const, blobKey, mimeType, sizeBytes: 1024 });

describe('Twilio WhatsApp rendering', () => {
  it('converts CommonMark with the shared WhatsApp formatter', () => {
    expect(payloads([{ type: 'TEXT', text: '**Card blocked.** See [status](https://meridian.example/s) ~~now~~' }])).toEqual([
      { type: 'text', body: '*Card blocked.* See status (https://meridian.example/s) ~now~' },
    ]);
  });

  it('chunks text to Twilio’s 1,600-character Body limit on sentence boundaries', () => {
    const sentence = 'Your statement for September is ready and includes every EMI debit. ';
    const rendered = render([{ type: 'TEXT', text: sentence.repeat(60) }]);
    expect(rendered.length).toBeGreaterThan(2);
    for (const r of rendered) {
      const body = String(r.payload['body']);
      expect(body.length).toBeLessThanOrEqual(TWILIO_BODY_LIMIT);
      expect(body.endsWith('.')).toBe(true);
      expect(r).toMatchObject({ kind: 'TWILIO_WHATSAPP', partIndexes: [0] });
    }
  });

  it('images carry their caption as Body; other media send the caption as a following text', () => {
    expect(payloads([{ type: 'IMAGE', media: stored('image/png', 'outbound/p.png'), caption: 'Your *receipt*' }])).toEqual([
      { type: 'media', mediaKind: 'IMAGE', blobKey: 'outbound/p.png', mimeType: 'image/png', caption: 'Your _receipt_' },
    ]);
    expect(payloads([{ type: 'DOCUMENT', media: stored('application/pdf', 'outbound/s.pdf'), caption: 'Statement' }])).toEqual([
      { type: 'media', mediaKind: 'DOCUMENT', blobKey: 'outbound/s.pdf', mimeType: 'application/pdf' },
      { type: 'text', body: 'Statement' },
    ]);
  });

  it('refuses media that is not stored, of a type Twilio cannot send, or too large', () => {
    expect(() => render([{ type: 'IMAGE', media: { status: 'PENDING', mimeType: 'image/png' } }])).toThrowError(expect.objectContaining({ code: 'outbound_media_not_stored' }));
    expect(() => render([{ type: 'IMAGE', media: stored('image/webp') }])).toThrowError(expect.objectContaining({ code: 'outbound_media_type_not_allowed' }));
    expect(() => render([{ type: 'VIDEO', media: { ...stored('video/mp4'), sizeBytes: 17 * 1024 * 1024 } }])).toThrowError(expect.objectContaining({ code: 'outbound_media_too_large' }));
  });

  it('locations use name as Body and address as label', () => {
    expect(payloads([{ type: 'LOCATION', latitude: 19.076, longitude: 72.8777, name: 'Branch', address: 'Nariman Point' }])).toEqual([
      { type: 'location', latitude: 19.076, longitude: 72.8777, name: 'Branch', label: 'Nariman Point' },
    ]);
    expect(payloads([{ type: 'LOCATION', latitude: 1, longitude: 2 }])).toEqual([{ type: 'location', latitude: 1, longitude: 2, name: '1, 2' }]);
  });

  it('contact cards and buttons become text (interactive messages need Content Templates on Twilio)', () => {
    expect(payloads([{ type: 'CONTACT', contacts: [{ name: 'Branch desk', phones: ['+912222000000'], emails: [], organization: 'Meridian' }] }])).toEqual([
      { type: 'text', body: '*Branch desk*\nMeridian\n+912222000000' },
    ]);
    expect(payloads([{ type: 'STRUCTURED', schema: 'buttons', data: { body: 'Block the card?', buttons: [{ id: 'y', title: 'Yes' }, { id: 'n', title: 'No' }] } }])).toEqual([
      { type: 'text', body: 'Block the card?\n\n1. Yes\n2. No' },
    ]);
    expect(payloads([{ type: 'STRUCTURED', schema: 'x', data: {}, fallbackText: 'Pick one' }])).toEqual([{ type: 'text', body: 'Pick one' }]);
  });

  it('never renders tool results', () => {
    expect(render([{ type: 'TOOL_RESULT', toolCallId: 'c', toolName: 'refund', status: 'SUCCEEDED', summary: { secret: 'x' } }, { type: 'TEXT', text: 'Done' }])).toEqual([
      { kind: 'TWILIO_WHATSAPP', payload: { type: 'text', body: 'Done' }, partIndexes: [1] },
    ]);
  });
});
