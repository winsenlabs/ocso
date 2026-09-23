import { linkify, type TextSegment } from './linkify';

/**
 * Web chat text is CommonMark-flavoured (packages/channels webchat
 * capabilities). This is a deliberately small, safe subset — paragraphs, line
 * breaks, bullet/numbered lists, **bold**, *italic* and `code` — parsed into
 * a tree the widget renders as React elements. No HTML is ever produced or
 * interpreted; links come only from linkify (http/https).
 */

export type InlineStyle = 'plain' | 'strong' | 'em' | 'code';
export interface Inline {
  style: InlineStyle;
  segments: TextSegment[];
}
/** One visual line of inline runs. */
export type Line = Inline[];

export type Block = { type: 'p'; lines: Line[] } | { type: 'ul'; items: Line[] } | { type: 'ol'; items: Line[]; start: number };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|(?<![*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g;
const BULLET = /^\s{0,3}[-*•]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

export function parseInline(text: string): Line {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ style: 'plain', segments: linkify(text.slice(last, m.index)) });
    if (m[1] !== undefined) out.push({ style: 'code', segments: [{ type: 'text', text: m[1] }] });
    else if (m[2] !== undefined) out.push({ style: 'strong', segments: linkify(m[2]) });
    else if (m[3] !== undefined) out.push({ style: 'em', segments: linkify(m[3]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ style: 'plain', segments: linkify(text.slice(last)) });
  return out;
}

export function parseRichText(text: string): Block[] {
  const blocks: Block[] = [];
  const push = (block: Block) => blocks.push(block);
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const current = blocks.at(-1);
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (!line.trim()) {
      if (current) push({ type: 'p', lines: [] });
    } else if (bullet) {
      if (current?.type === 'ul') current.items.push(parseInline(bullet[1] ?? ''));
      else push({ type: 'ul', items: [parseInline(bullet[1] ?? '')] });
    } else if (numbered) {
      if (current?.type === 'ol') current.items.push(parseInline(numbered[2] ?? ''));
      else push({ type: 'ol', start: Number(numbered[1]), items: [parseInline(numbered[2] ?? '')] });
    } else if (current?.type === 'p') {
      current.lines.push(parseInline(line));
    } else {
      push({ type: 'p', lines: [parseInline(line)] });
    }
  }
  return blocks.filter((b) => (b.type === 'p' ? b.lines.length > 0 : b.items.length > 0));
}
