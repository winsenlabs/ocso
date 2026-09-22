/**
 * Safe text → segments. Only explicit http(s) URLs become links; anything
 * else (javascript:, data:, mailto:, bare domains) stays plain text. Output is
 * rendered as React text/elements — never as HTML.
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

/** An absolute http(s) URL, normalized; null for anything else. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Media URLs from the API are signed absolute http(s) URLs (or same-origin
 * paths); local previews are blob: URLs created by this widget.
 */
export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('blob:')) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return safeHttpUrl(value);
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const url = trimUrl(match[0]);
    const href = safeHttpUrl(url);
    if (!href || !url) continue;
    if (start > last) segments.push({ type: 'text', text: text.slice(last, start) });
    segments.push({ type: 'link', href, text: url });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
  return segments.reduce<TextSegment[]>((acc, seg) => {
    const prev = acc.at(-1);
    if (prev?.type === 'text' && seg.type === 'text') prev.text += seg.text;
    else acc.push({ ...seg });
    return acc;
  }, []);
}
