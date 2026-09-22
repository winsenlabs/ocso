/**
 * Union of scope sets, first-seen order, for OAuth step-up (spec: re-authorize
 * with previously requested ∪ challenged scopes). Accepts arrays or
 * space-delimited strings, e.g. `unionScopes(target.auth.scopes, authRequired.challengedScope)`.
 */
export function unionScopes(...sets: ReadonlyArray<readonly string[] | string | null | undefined>): string[] {
  const out: string[] = [];
  for (const set of sets) {
    const items = typeof set === 'string' ? set.split(' ') : (set ?? []);
    for (const s of items) if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
