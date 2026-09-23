import { describe, expect, it } from 'vitest';
import { linkify, safeMediaUrl } from '../../../lib/webchat/linkify';
import { parseRichText } from '../../../lib/webchat/rich-text';
import { backoffDelay, createSseParser, type SseMessage } from '../../../lib/webchat/sse';

describe('linkify', () => {
  it('links only explicit http(s) URLs and trims trailing punctuation', () => {
    expect(linkify('See https://bank.example/help?q=1, or (https://bank.example/a_(b)) now.')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', href: 'https://bank.example/help?q=1', text: 'https://bank.example/help?q=1' },
      { type: 'text', text: ', or (' },
      { type: 'link', href: 'https://bank.example/a_(b)', text: 'https://bank.example/a_(b)' },
      { type: 'text', text: ') now.' },
    ]);
  });

  it('never links javascript:, data:, mailto: or bare domains, and keeps HTML as text', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'mailto:a@b.c', 'bank.example/login', '<a href="https://x.test">x</a>']) {
      const segments = linkify(text);
      if (text.startsWith('<a')) expect(segments.filter((s) => s.type === 'link').map((s) => s.type === 'link' && s.href)).toEqual(['https://x.test/']);
      else expect(segments).toEqual([{ type: 'text', text }]);
    }
  });

  it('accepts only same-origin paths, http(s) and local blob: URLs for media', () => {
    expect(safeMediaUrl('/blobs/a?sig=1')).toBe('/blobs/a?sig=1');
    expect(safeMediaUrl('https://s3.example/a')).toBe('https://s3.example/a');
    expect(safeMediaUrl('blob:http://localhost/1')).toBe('blob:http://localhost/1');
    expect(safeMediaUrl('//evil.test/a')).toBeNull();
    expect(safeMediaUrl('javascript:alert(1)')).toBeNull();
    expect(safeMediaUrl(undefined)).toBeNull();
  });
});

describe('rich text', () => {
  it('parses paragraphs, line breaks, lists and inline styles into a tree', () => {
    const blocks = parseRichText('Your options:\n- **Reverse** the debit\n- Keep it\n\n1. Visit https://bank.example\n2. Use `RVSL-1`\nThanks *Priya*');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'ol', 'p']);
    const [, ul, ol, last] = blocks;
    expect(ul?.type === 'ul' && ul.items[0]?.map((i) => i.style)).toEqual(['strong', 'plain']);
    expect(ol?.type === 'ol' && ol.items[0]?.[0]?.segments).toEqual([
      { type: 'text', text: 'Visit ' },
      { type: 'link', href: 'https://bank.example/', text: 'https://bank.example' },
    ]);
    expect(ol?.type === 'ol' && ol.items[1]?.[1]).toEqual({ style: 'code', segments: [{ type: 'text', text: 'RVSL-1' }] });
    expect(last?.type === 'p' && last.lines[0]?.map((i) => i.style)).toEqual(['plain', 'em']);
  });

  it('does not treat arithmetic or snake_case as emphasis', () => {
    const [p] = parseRichText('2 * 3 * 4 and snake_case_name');
    expect(p?.type === 'p' && p.lines[0]?.every((i) => i.style === 'plain')).toBe(true);
  });
});

describe('SSE parser', () => {
  it('handles chunk boundaries, CRLF, multi-line data and comments', () => {
    const out: SseMessage[] = [];
    const parser = createSseParser((m) => out.push(m));
    parser.push(': keepalive\r\nevent: delta\r\ndata: {"turnId":"t1",');
    parser.push('"text":"Hi"}\r');
    parser.push('\n\r\nevent: message\ndata: line1\ndata: line2\n\nid: 7\ndata: {}\n');
    parser.end();
    expect(out).toEqual([
      { event: 'delta', data: '{"turnId":"t1","text":"Hi"}', id: null },
      { event: 'message', data: 'line1\nline2', id: null },
      { event: 'message', data: '{}', id: '7' },
    ]);
  });

  it('backs off exponentially with jitter up to the cap', () => {
    const opts = { baseMs: 1_000, maxMs: 30_000, jitter: 0.3 };
    expect(backoffDelay(1, opts, () => 1)).toBe(1_000);
    expect(backoffDelay(1, opts, () => 0)).toBe(700);
    expect(backoffDelay(3, opts, () => 1)).toBe(4_000);
    expect(backoffDelay(20, opts, () => 1)).toBe(30_000);
  });
});
