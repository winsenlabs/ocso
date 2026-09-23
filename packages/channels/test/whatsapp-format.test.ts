import { describe, expect, it } from 'vitest';
import { chunkText, toWhatsAppText } from '../src/index.js';

describe('CommonMark -> WhatsApp formatting', () => {
  it.each([
    ['**bold**', '*bold*'],
    ['__bold__', '*bold*'],
    ['*italic*', '_italic_'],
    ['_italic_', '_italic_'],
    ['***both***', '*_both_*'],
    ['~~gone~~', '~gone~'],
    ['use `code` here', 'use `code` here'],
    ['Your **refund of ₹12,480** is *on its way*.', 'Your *refund of ₹12,480* is _on its way_.'],
  ])('%s -> %s', (input, expected) => {
    expect(toWhatsAppText(input)).toBe(expected);
  });

  it('turns headings into bold lines and drops horizontal rules', () => {
    expect(toWhatsAppText('# Card blocked\n\nDone.\n\n---\n\n## Next steps\nCall us')).toBe(
      '*Card blocked*\n\nDone.\n\n*Next steps*\nCall us',
    );
  });

  it('does not double-bold headings that already contain bold', () => {
    expect(toWhatsAppText('### **Important**')).toBe('*Important*');
  });

  it('converts fenced code blocks to monospace and leaves their contents untouched', () => {
    expect(toWhatsAppText('Run:\n```bash\necho **not bold** _x_\n```\nok')).toBe('Run:\n```echo **not bold** _x_```\nok');
  });

  it('keeps URLs intact even when they contain underscores or asterisks', () => {
    expect(toWhatsAppText('See https://bank.example/help_center/card_block for *details*')).toBe(
      'See https://bank.example/help_center/card_block for _details_',
    );
  });

  it('rewrites links and images as text with the URL', () => {
    expect(toWhatsAppText('[Dispute form](https://bank.example/d_form) or ![chart](https://x.example/c.png)')).toBe(
      'Dispute form (https://bank.example/d_form) or chart (https://x.example/c.png)',
    );
    expect(toWhatsAppText('[https://a.example](https://a.example)')).toBe('https://a.example');
  });

  it('flattens tables into a bold header row and plain rows', () => {
    const table = '| Date | Amount |\n|------|-------:|\n| 14 Sep | ₹12,480 |\n| 15 Sep | ₹399 |';
    expect(toWhatsAppText(`Charges:\n${table}\nThanks`)).toBe('Charges:\n*Date | Amount*\n14 Sep | ₹12,480\n15 Sep | ₹399\nThanks');
  });

  it('normalizes bullets so they are not mistaken for bold', () => {
    expect(toWhatsAppText('* one\n+ two\n- three\n1. four')).toBe('- one\n- two\n- three\n1. four');
  });

  it('respects backslash escapes', () => {
    expect(toWhatsAppText('2 \\* 3 \\* 4 and \\_raw\\_')).toBe('2 * 3 * 4 and _raw_');
  });

  it('collapses excess blank lines and trims', () => {
    expect(toWhatsAppText('\n\nHello\n\n\n\nWorld  \n\n')).toBe('Hello\n\nWorld');
  });
});

describe('chunking to the 4096 limit', () => {
  const limit = 4096;
  const paragraph = (n: number) => `${'Lorem ipsum dolor sit amet. '.repeat(n).trim()}`;

  it('leaves short text as a single chunk and empty text as none', () => {
    expect(chunkText('hello', limit)).toEqual(['hello']);
    expect(chunkText('', limit)).toEqual([]);
  });

  it('splits on paragraph boundaries first', () => {
    const a = paragraph(100);
    const b = paragraph(100);
    const chunks = chunkText(`${a}\n\n${b}`, limit);
    expect(chunks).toEqual([a, b]);
  });

  it('splits on sentence boundaries when there are no paragraphs', () => {
    const text = paragraph(300);
    const chunks = chunkText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.endsWith('.') || chunk === chunks.at(-1)).toBe(true);
    }
    expect(chunks.join(' ')).toBe(text);
  });

  it('falls back to word boundaries, then hard cuts, never splitting emoji', () => {
    const words = chunkText('word '.repeat(2000).trim(), limit);
    expect(words.every((c) => c.length <= limit && !c.startsWith(' ') && c.endsWith('word'))).toBe(true);
    const emoji = chunkText('😀'.repeat(3000), limit);
    expect(emoji.every((c) => c.length <= limit)).toBe(true);
    expect(emoji.join('')).toBe('😀'.repeat(3000));
  });

  it('closes and reopens a code block cut across chunks', () => {
    const code = `\`\`\`${'x = 1\n'.repeat(1200)}\`\`\``;
    const chunks = chunkText(code, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.split('```').length % 2).toBe(1); // balanced fences
    }
  });
});
