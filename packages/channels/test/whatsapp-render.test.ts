import { describe, expect, it } from 'vitest';
import type { InteractionPart, MediaRef } from '@ocso/domain';
import { createWhatsAppAdapter, type RenderedOutbound } from '../src/index.js';
import { waConfig } from './helpers/whatsapp.js';

const adapter = createWhatsAppAdapter({ fetch: () => Promise.reject(new Error('offline')) });
const config = waConfig();
const render = (parts: InteractionPart[]): RenderedOutbound[] => adapter.render(parts, config);
const payloads = (parts: InteractionPart[]) => render(parts).map((r) => r.payload);

const stored = (mimeType: string, extra: Partial<MediaRef> = {}): MediaRef => ({
  status: 'STORED',
  blobKey: `outbound/${mimeType.replace('/', '-')}`,
  mimeType,
  sizeBytes: 1024,
  ...extra,
});

const toolResult: InteractionPart = {
  type: 'TOOL_RESULT',
  toolCallId: 'call_1',
  toolName: 'core_cards__reverse_transaction',
  status: 'SUCCEEDED',
  summary: { internalRef: 'REV-99812', ledger: 'secret-ledger-note' },
};

describe('WhatsApp render — rendering policy', () => {
  it('never renders TOOL_RESULT parts and keeps source indexes for the rest', () => {
    const rendered = render([{ type: 'TEXT', text: 'Reversal done.' }, toolResult, { type: 'TEXT', text: 'Anything else?' }]);
    expect(rendered.map((r) => r.partIndexes)).toEqual([[0], [2]]);
    expect(JSON.stringify(rendered)).not.toContain('REV-99812');
    expect(JSON.stringify(rendered)).not.toContain('core_cards');
    expect(render([toolResult])).toEqual([]);
  });

  it('formats text for WhatsApp and marks link previews', () => {
    expect(payloads([{ type: 'TEXT', text: 'Your **card** is blocked. See https://bank.example/help' }])).toEqual([
      { type: 'text', body: 'Your *card* is blocked. See https://bank.example/help', previewUrl: true },
    ]);
    expect(payloads([{ type: 'TEXT', text: 'plain' }])).toEqual([{ type: 'text', body: 'plain', previewUrl: false }]);
  });

  it('chunks long text into several messages that all point at the source part', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${'Details follow here. '.repeat(30)}`).join('\n\n');
    const rendered = render([{ type: 'TEXT', text }]);
    expect(rendered.length).toBeGreaterThan(1);
    for (const r of rendered) {
      expect(r.partIndexes).toEqual([0]);
      expect((r.payload['body'] as string).length).toBeLessThanOrEqual(4096);
    }
  });
});

describe('WhatsApp render — media, location, contacts', () => {
  it('renders media parts as media payloads that reference BlobStore (resolved at send)', () => {
    expect(
      payloads([
        { type: 'IMAGE', media: stored('image/jpeg'), caption: 'Your **receipt**' },
        { type: 'DOCUMENT', media: stored('application/pdf', { filename: 'statement.pdf' }), caption: 'Statement' },
        { type: 'AUDIO', media: stored('audio/ogg; codecs=opus') },
        { type: 'VIDEO', media: stored('video/mp4') },
      ]),
    ).toEqual([
      { type: 'media', mediaType: 'image', blobKey: 'outbound/image-jpeg', mimeType: 'image/jpeg', caption: 'Your *receipt*' },
      {
        type: 'media',
        mediaType: 'document',
        blobKey: 'outbound/application-pdf',
        mimeType: 'application/pdf',
        filename: 'statement.pdf',
        caption: 'Statement',
      },
      { type: 'media', mediaType: 'audio', blobKey: 'outbound/audio-ogg; codecs=opus', mimeType: 'audio/ogg; codecs=opus' },
      { type: 'media', mediaType: 'video', blobKey: 'outbound/video-mp4', mimeType: 'video/mp4' },
    ]);
  });

  it('sends captions longer than 1024 chars as follow-up text', () => {
    const caption = 'Long caption. '.repeat(100);
    const out = payloads([{ type: 'IMAGE', media: stored('image/png'), caption }]);
    expect(out[0]).not.toHaveProperty('caption');
    expect(out.slice(1).every((p) => p['type'] === 'text')).toBe(true);
  });

  it('refuses media that is not stored, not sendable, or too large', () => {
    const pending: MediaRef = { status: 'PENDING', mimeType: 'image/jpeg' };
    expect(() => render([{ type: 'IMAGE', media: pending }])).toThrowError(expect.objectContaining({ code: 'outbound_media_not_stored' }));
    expect(() => render([{ type: 'IMAGE', media: stored('image/webp') }])).toThrowError(
      expect.objectContaining({ code: 'outbound_media_type_not_allowed' }),
    );
    expect(() => render([{ type: 'VIDEO', media: stored('video/mp4', { sizeBytes: 17 * 1024 * 1024 }) }])).toThrowError(
      expect.objectContaining({ code: 'outbound_media_too_large' }),
    );
  });

  it('renders LOCATION and CONTACT parts', () => {
    expect(
      payloads([
        { type: 'LOCATION', latitude: 19.076, longitude: 72.8777, name: 'Nariman Point branch' },
        { type: 'CONTACT', contacts: [{ name: 'Card helpline', phones: ['+18001234567'], emails: [], organization: 'Meridian' }] },
      ]),
    ).toEqual([
      { type: 'location', latitude: 19.076, longitude: 72.8777, name: 'Nariman Point branch' },
      {
        type: 'contacts',
        contacts: [
          { name: { formatted_name: 'Card helpline', first_name: 'Card helpline' }, phones: [{ phone: '+18001234567' }], org: { company: 'Meridian' } },
        ],
      },
    ]);
  });
});

describe('WhatsApp render — structured', () => {
  const buttons = (n: number, extra: Record<string, unknown> = {}): InteractionPart => ({
    type: 'STRUCTURED',
    schema: 'buttons',
    data: {
      body: 'Should I **block** the card ending 4821?',
      buttons: Array.from({ length: n }, (_, i) => ({ id: `opt-${i}`, title: i === 0 ? 'Yes, block it right now please' : `Option ${i}` })),
      ...extra,
    },
    fallbackText: 'Reply YES to block the card ending 4821.',
  });

  it('renders ≤3 buttons as interactive reply buttons with titles cut to 20 chars', () => {
    expect(payloads([buttons(2, { footer: 'Meridian Bank' })])).toEqual([
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Should I *block* the card ending 4821?' },
          footer: { text: 'Meridian Bank' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'opt-0', title: 'Yes, block it right…' } },
              { type: 'reply', reply: { id: 'opt-1', title: 'Option 1' } },
            ],
          },
        },
      },
    ]);
  });

  it('falls back to fallbackText for more than 3 buttons', () => {
    expect(payloads([buttons(4)])).toEqual([{ type: 'text', body: 'Reply YES to block the card ending 4821.', previewUrl: false }]);
  });

  it('generates a numbered list when there is no fallbackText', () => {
    const { fallbackText: _omit, ...part } = buttons(4) as Extract<InteractionPart, { type: 'STRUCTURED' }>;
    expect(payloads([part])[0]?.['body']).toBe('Should I *block* the card ending 4821?\n\n1. Yes, block it right now please\n2. Option 1\n3. Option 2\n4. Option 3');
  });

  it('uses fallbackText for other schemas and drops structures with no text form', () => {
    expect(payloads([{ type: 'STRUCTURED', schema: 'card', data: { x: 1 }, fallbackText: 'Card summary' }])).toEqual([
      { type: 'text', body: 'Card summary', previewUrl: false },
    ]);
    expect(render([{ type: 'STRUCTURED', schema: 'internal_state', data: { secret: true } }])).toEqual([]);
  });
});
