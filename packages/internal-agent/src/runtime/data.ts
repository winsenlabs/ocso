import { createHash } from 'node:crypto';
import { DomainError } from '@ocso/domain';

/** JSON with sorted keys and no undefined values: equal data always hashes the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort()
        .map((k) => [k, sortDeep(record[k])]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export const MAX_ROWS = 50;
const MAX_STRING = 800;
const MAX_DEPTH = 8;
const MAX_CHARS = 24_000;

/**
 * A read result cut to what a model turn can hold (PM/research/12 §9): at most 50 rows per list, long strings
 * shortened, deep nesting summarised. When it is still too large, lists shrink further. `truncated` says so.
 */
export function trimResult(data: unknown): { data: unknown; truncated: boolean } {
  let truncated = false;
  const cut = (value: unknown, depth: number, rows: number, chars: number): unknown => {
    if (typeof value === 'string') {
      if (value.length <= chars) return value;
      truncated = true;
      return `${value.slice(0, chars)}… [cut ${value.length - chars} characters]`;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return Array.isArray(value) ? `[${value.length} items]` : '{…}';
    }
    if (Array.isArray(value)) {
      const kept = value.slice(0, rows).map((v) => cut(v, depth + 1, rows, chars));
      if (value.length > rows) {
        truncated = true;
        kept.push(`… ${value.length - rows} more not shown`);
      }
      return kept;
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cut(v, depth + 1, rows, chars)]));
  };
  let out = cut(data, 0, MAX_ROWS, MAX_STRING);
  if (JSON.stringify(out ?? null).length > MAX_CHARS) out = cut(data, 0, 15, 200);
  if (JSON.stringify(out ?? null).length > MAX_CHARS) {
    truncated = true;
    const text = JSON.stringify(out);
    out = `${text.slice(0, MAX_CHARS)}… [cut]`;
  }
  return { data: out, truncated };
}

/** A value as one short line on a card. */
export function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * The longest value a card shows (PM/research/12 §9): what a confirm sends is shown in full on the card, never cut,
 * so an injected tail in a reply or note is visible before the click. A longer value is refused (make it in OCSO).
 */
export const CARD_VALUE_MAX = 20_000;

/** A value a write will send, in full (multi-line; objects as indented JSON). Throws when it is too long to review on a card. */
export function displayFull(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text =
    typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : value instanceof Date ? value.toISOString() : (JSON.stringify(value, null, 2) ?? String(value));
  if (text.length > CARD_VALUE_MAX) {
    throw new DomainError('validation', 'value_too_long_for_card', `A value is ${text.length} characters: too long to review on a confirmation card (at most ${CARD_VALUE_MAX}). Make this change in OCSO directly.`);
  }
  return text;
}

/** `modelProfileId` → "model profile", `business_hours` → "business hours". */
export function label(key: string): string {
  return key
    .split('.')
    .map((part) =>
      part
        .replace(/Ids?$/, (m) => (m === 'Ids' ? 's' : ''))
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim(),
    )
    .join(' · ');
}

/** The display name of an API object: name, title, display id, email… or null. */
export function nameOf(object: unknown): string | null {
  if (!object || typeof object !== 'object') return null;
  const o = object as Record<string, unknown>;
  for (const key of ['name', 'title', 'displayName', 'label', 'displayId', 'email', 'slug']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const customer = o['customer'];
  if (customer && typeof customer === 'object') {
    const n = (customer as Record<string, unknown>)['name'];
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  return null;
}

/** The rows of a list result: an array, or the first array under items / rows / data / results / … */
export function rowsOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const key of ['items', 'rows', 'data', 'results', 'conversations', 'agents', 'users', 'proposals']) {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}
