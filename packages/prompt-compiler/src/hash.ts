import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Used for every
 * cache/version hash so logically-equal inputs always hash identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short, prefixed content hash for display and cache keys, e.g. `pc_4f81…`. */
export function contentHash(value: unknown, prefix = 'h'): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return `${prefix}_${sha256Hex(text).slice(0, 24)}`;
}
