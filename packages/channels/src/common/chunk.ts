import { safeCutIndex } from './text.js';

/**
 * Split long text into provider-sized messages, preferring (in order)
 * paragraph, line, sentence and word boundaries before a hard cut.
 * Triple-backtick code blocks cut across a boundary are closed at the end of
 * one chunk and reopened at the start of the next, so formatting survives.
 */

const FENCE = '```';
const SENTENCE_END = /[.!?…](?:["')\]]*)\s+/g;

interface Boundary {
  find: (window: string) => number;
  /** Minimum fraction of the window a cut must keep, to avoid tiny chunks. */
  minFraction: number;
}

const lastIndex = (needle: string) => (window: string) => {
  const at = window.lastIndexOf(needle);
  return at < 0 ? -1 : at;
};

const lastSentenceEnd = (window: string): number => {
  let cut = -1;
  for (const match of window.matchAll(SENTENCE_END)) cut = match.index + match[0].trimEnd().length;
  return cut;
};

const lastWhitespace = (window: string): number => {
  const match = /\s\S*$/.exec(window);
  return match ? match.index : -1;
};

const BOUNDARIES: readonly Boundary[] = [
  { find: lastIndex('\n\n'), minFraction: 0.5 },
  { find: lastIndex('\n'), minFraction: 0.5 },
  { find: lastSentenceEnd, minFraction: 0.3 },
  { find: lastWhitespace, minFraction: 0.2 },
];

function findCut(text: string, limit: number): number {
  const window = text.slice(0, limit);
  for (const boundary of BOUNDARIES) {
    const cut = boundary.find(window);
    if (cut > 0 && cut >= limit * boundary.minFraction) return cut;
  }
  return safeCutIndex(text, limit);
}

function countFences(text: string): number {
  return text.split(FENCE).length - 1;
}

export function chunkText(text: string, limit: number): string[] {
  if (limit <= FENCE.length * 2) throw new RangeError('chunk limit too small');
  if (text.length <= limit) return text.length ? [text] : [];
  const chunks: string[] = [];
  // Reserve room for a closing fence so a balanced chunk never exceeds the limit.
  const budget = limit - FENCE.length;
  let rest = text;
  while (rest.length > limit) {
    const cut = findCut(rest, budget);
    let head = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).trimStart();
    if (countFences(head) % 2 === 1) {
      head = `${head}${FENCE}`;
      rest = `${FENCE}${rest}`;
    }
    if (head.length) chunks.push(head);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}
