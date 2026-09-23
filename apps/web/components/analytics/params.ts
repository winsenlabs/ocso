/** Search-param helpers for the operations pages (client-safe). */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export type Params = Record<string, string | string[] | undefined>;

/** First non-empty string value of a search param. */
export function param(params: Params, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first ? first : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A search param that must be an id; anything else is ignored rather than sent to the API. */
export function idParam(params: Params, key: string): string | undefined {
  const value = param(params, key);
  return value && UUID.test(value) ? value : undefined;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `/path?a=1&b=2`, dropping empty values. */
export function hrefWith(path: string, query: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
