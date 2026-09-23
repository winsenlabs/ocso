import type { WorldIds } from './world.js';

const REF = /@([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*)/g;

/** The world id for a ref key, trying the longest dotted prefix first (`@agent.maya` inside `/agents/@agent.maya`). */
function lookup(key: string, ids: WorldIds): string | undefined {
  const parts = key.split('.');
  for (let n = parts.length; n > 0; n--) {
    const candidate = parts.slice(0, n).join('.');
    if (candidate in ids) return `${ids[candidate as keyof WorldIds]}${n < parts.length ? `.${parts.slice(n).join('.')}` : ''}`;
  }
  return undefined;
}

/** Replace world refs (`@agent.maya`) with ids, deeply. Unknown refs are left as written (a scenario test catches them). */
export function resolveRefs<T>(value: T, ids: WorldIds): T {
  if (typeof value === 'string') return value.replace(REF, (whole, key: string) => lookup(key, ids) ?? whole) as T;
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ids)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ids)])) as T;
  return value;
}

/** Every ref a value uses (for the scenario data test). */
export function refsIn(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(REF)].map((m) => m[1]!);
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(refsIn);
  return [];
}
