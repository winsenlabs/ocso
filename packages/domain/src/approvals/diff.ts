/**
 * Field-level diff of two approval snapshots (PM/research/11b). Pure and
 * browser-safe: the API freezes it on every decision row and the web renders
 * the same shape, so both sides agree on what "changed" means.
 */
export interface DiffField {
  /** Dotted path, e.g. `businessHours.timezone`. */
  path: string;
  before: unknown;
  after: unknown;
  change: 'added' | 'removed' | 'changed';
}

/** Deeper objects are compared whole at this depth. */
export const DIFF_MAX_DEPTH = 6;
/** At most this many fields are reported; the rest are summarised by the caller. */
export const DIFF_MAX_FIELDS = 200;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value === undefined ? null : value;
}

function equal(a: unknown, b: unknown): boolean {
  return stableJson(normalize(a)) === stableJson(normalize(b));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

/**
 * Differences between two projections. Objects are walked key by key (sorted,
 * so equal inputs always give the same order) up to DIFF_MAX_DEPTH; arrays and
 * scalars are compared whole. `null` and a missing key are the same value.
 */
export function diffFields(before: unknown, after: unknown): DiffField[] {
  const out: DiffField[] = [];
  walk(before ?? null, after ?? null, '', 0, out);
  return out;
}

function walk(before: unknown, after: unknown, path: string, depth: number, out: DiffField[]): void {
  if (out.length >= DIFF_MAX_FIELDS) return;
  if (isPlainObject(before) && isPlainObject(after) && depth < DIFF_MAX_DEPTH) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) walk(before[key] ?? null, after[key] ?? null, path ? `${path}.${key}` : key, depth + 1, out);
    return;
  }
  if (equal(before, after)) return;
  if (!path && (before === null || after === null)) {
    // A whole object appeared or disappeared (CREATE / DELETE): list its top-level fields.
    const side = (before ?? after) as unknown;
    if (isPlainObject(side)) {
      for (const key of Object.keys(side).sort()) {
        if (out.length >= DIFF_MAX_FIELDS) return;
        const value = normalize(side[key]);
        if (value === null) continue;
        out.push(before === null ? { path: key, before: null, after: value, change: 'added' } : { path: key, before: value, after: null, change: 'removed' });
      }
      return;
    }
  }
  const b = normalize(before);
  const a = normalize(after);
  out.push({ path: path || '(value)', before: b, after: a, change: b === null ? 'added' : a === null ? 'removed' : 'changed' });
}

/** "name, business hours, model profile" — the changed top-level fields in plain words, for titles and emails. */
export function describeDiff(fields: readonly DiffField[]): string {
  if (!fields.length) return 'no changes';
  const seen: string[] = [];
  for (const f of fields) {
    const top = f.path.split('.')[0] ?? f.path;
    const words = humanize(top);
    if (!seen.includes(words)) seen.push(words);
  }
  if (seen.length <= 6) return seen.join(', ');
  return `${seen.slice(0, 5).join(', ')} and ${seen.length - 5} more`;
}

/** `modelProfileId` → "model profile", `business_hours` → "business hours". */
export function humanize(key: string): string {
  return key
    .replace(/Id$/, '')
    .replace(/Ids$/, 's')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}
