import { describe, expect, it } from 'vitest';
import { acceptedMimeTypes, backoffDelay, checkAttachment, createSseParser, linkify, mimeTypeOf, type SseMessage } from '../src/index.js';
import { coreReducer, initialCoreState } from '../src/reducer.js';
import { createUtf8Decoder } from '../src/sse.js';
import { safeMediaUrl, toParts } from '../src/view.js';
import { parseConfig, parseHistory, parseLiveEvent } from '../src/wire.js';
import { config } from './helpers/fake-server.js';

describe('SSE parser', () => {
  it('parses events split across chunks and CRLF line endings', () => {
    const out: SseMessage[] = [];
    const parser = createSseParser((m) => out.push(m));
    parser.push('event: delta\r\ndata: {"turnId":"t","te');
    parser.push('xt":"hi"}\r');
    parser.push('\n\r\n: comment\n\nevent: ping\ndata: {}\n\n');
    expect(out).toEqual([
      { event: 'delta', data: '{"turnId":"t","text":"hi"}', id: null },
      { event: 'ping', data: '{}', id: null },
    ]);
  });

  it('joins multi-line data and flushes on end', () => {
    const out: SseMessage[] = [];
    const parser = createSseParser((m) => out.push(m));
    parser.push('data: a\ndata: b');
    parser.end();
    expect(out).toEqual([{ event: 'message', data: 'a\nb', id: null }]);
  });

  it('backs off exponentially within bounds', () => {
    expect(backoffDelay(1, { baseMs: 1000, maxMs: 30_000, jitter: 0 })).toBe(1000);
    expect(backoffDelay(4, { baseMs: 1000, maxMs: 30_000, jitter: 0 })).toBe(8000);
    expect(backoffDelay(20, { baseMs: 1000, maxMs: 30_000, jitter: 0 })).toBe(30_000);
  });
});

describe('UTF-8 fallback decoder (runtimes without TextDecoder)', () => {
  it('decodes multi-byte characters split across chunks', () => {
    const original = globalThis.TextDecoder;
    // @ts-expect-error simulate a runtime without TextDecoder
    delete globalThis.TextDecoder;
    try {
      const decoder = createUtf8Decoder();
      const bytes = new TextEncoder().encode('héllo 👋 ok');
      const a = decoder.decode(bytes.slice(0, 2));
      const b = decoder.decode(bytes.slice(2, 9));
      const c = decoder.decode(bytes.slice(9));
      expect(a + b + c).toBe('héllo 👋 ok');
    } finally {
      globalThis.TextDecoder = original;
    }
  });
});

describe('wire parsing', () => {
  it('drops unknown parts and invalid messages instead of failing the page', () => {
    const history = parseHistory({
      conversationId: 'c1',
      messages: [
        { id: 'i1', seq: 1, from: 'agent', name: 'Maya', parts: [{ type: 'TEXT', text: 'ok' }, { type: 'TOOL_RESULT', x: 1 }], deliveryStatus: 'SENT', at: 't' },
        { id: 'i2', seq: 'bad', from: 'agent', parts: [] },
      ],
      status: { mode: 'weird', humanName: null },
    });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.parts).toEqual([{ type: 'TEXT', text: 'ok' }]);
    expect(history.status.mode).toBe('ai');
    expect(history.notices).toEqual([]);
  });

  it('validates config branding and fills defaults', () => {
    const parsed = parseConfig({ ...config(), branding: { accentColor: 'red', theme: 'neon' } });
    expect(parsed.branding).toEqual({ theme: 'light', position: 'right' });
    expect(() => parseConfig({})).toThrow();
  });

  it('parses live events and ignores unknown ones', () => {
    expect(parseLiveEvent('delta', { turnId: 't', text: 'x' })).toEqual({ event: 'delta', data: { turnId: 't', text: 'x' } });
    expect(parseLiveEvent('delta', { turnId: 't' })).toBeNull();
    expect(parseLiveEvent('surprise', {})).toBeNull();
  });
});

describe('parts', () => {
  it('maps media to safe URLs only', () => {
    const base = 'https://ocso.test';
    expect(safeMediaUrl('/blobs/x', base)).toBe('https://ocso.test/blobs/x');
    expect(safeMediaUrl('javascript:alert(1)', base)).toBeNull();
    expect(safeMediaUrl('//evil.test/x', base)).toBeNull();
    const parts = toParts(
      [
        { type: 'IMAGE', media: { mimeType: 'image/png', filename: 'a.png', status: 'STORED' }, url: 'https://cdn.test/a.png', caption: 'receipt' },
        { type: 'DOCUMENT', media: { mimeType: 'application/pdf', status: 'EXPIRED' } },
        { type: 'STRUCTURED', schema: 'other', data: {}, fallbackText: 'fallback' },
      ],
      base,
    );
    expect(parts).toEqual([
      { type: 'media', kind: 'image', url: 'https://cdn.test/a.png', mime: 'image/png', name: 'a.png' },
      { type: 'text', text: 'receipt' },
      { type: 'unavailable', reason: 'expired' },
      { type: 'text', text: 'fallback' },
    ]);
  });
});

describe('reducer', () => {
  it('drops stale typing and drafts on tick', () => {
    let s = coreReducer(initialCoreState, { type: 'typing', turnId: 't', status: 'THINKING', now: 0 });
    s = coreReducer(s, { type: 'tick', now: 46_000 });
    expect(s.typing).toBeNull();
    s = coreReducer(s, { type: 'delta', turnId: 't2', text: 'a', now: 0 });
    s = coreReducer(s, { type: 'tick', now: 121_000 });
    expect(s.drafts).toEqual([]);
  });
});

describe('helpers', () => {
  it('guesses MIME types from extensions', () => {
    expect(mimeTypeOf({ name: 'a.PDF', type: '' })).toBe('application/pdf');
    expect(mimeTypeOf({ name: 'x', type: 'Image/PNG; q=1' })).toBe('image/png');
  });

  it('checks attachments against channel limits', () => {
    const c = parseConfig(config());
    expect(acceptedMimeTypes(c)).toEqual(['image/png', 'image/jpeg', 'application/pdf']);
    expect(checkAttachment({ size: 10, type: 'image/png' }, c)).toEqual({ ok: true, kind: 'IMAGE', mimeType: 'image/png' });
    expect(checkAttachment({ size: 10, type: 'application/zip' }, c)).toEqual({ ok: false, reason: 'type' });
    expect(checkAttachment({ size: 50_000_000, type: 'image/png' }, c)).toMatchObject({ ok: false, reason: 'size' });
  });

  it('linkifies only http(s) URLs', () => {
    expect(linkify('see https://x.test/a). or javascript:alert(1)')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://x.test/a', text: 'https://x.test/a' },
      { type: 'text', text: '). or javascript:alert(1)' },
    ]);
  });
});
