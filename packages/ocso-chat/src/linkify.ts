/**
 * Safe text → segments for renderers. Only explicit http(s) URLs become links;
 * anything else (javascript:, data:, mailto:, bare domains) stays plain text.
 * Render the result as text/elements, never as HTML.
 */

export type TextSegment = { type: 'text'; text: string } | { type: 'link'; href: string; text: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"»”’]+$/;

/** Drop trailing punctuation and unbalanced closing brackets ("(see https://x.test/a)"). */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1).replace(TRAILING, '');
  }
  return url;
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const start = match.index;
    const url = trimUrl(match[0]);
    if (!/^https?:\/\/[^/?#\s]+/i.test(url)) continue;
    if (start > last) segments.push({ type: 'text', text: text.slice(last, start) });
    segments.push({ type: 'link', href: url, text: url });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
  return segments.reduce<TextSegment[]>((acc, seg) => {
    const prev = acc[acc.length - 1];
    if (prev?.type === 'text' && seg.type === 'text') prev.text += seg.text;
    else acc.push({ ...seg });
    return acc;
  }, []);
}
