import { createHash } from 'node:crypto';

/** Scope keys identify *what* an alert is about (provider, agent, tool, topic…). */
export type AlertScope = Readonly<Record<string, string | number | boolean | null>>;

/** Canonical, order-independent serialization of a scope. */
export function canonicalScope(scope: AlertScope): string {
  const entries = Object.entries(scope)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Stable deduplication key for (rule, scope). The same rule firing for the
 * same provider/agent/tool always yields the same fingerprint, so an open
 * alert is bumped instead of duplicated. Also used as PagerDuty `dedup_key`.
 */
export function fingerprint(ruleId: string, scope: AlertScope = {}): string {
  const digest = createHash('sha256').update(`${ruleId}\n${canonicalScope(scope)}`).digest('hex').slice(0, 32);
  return `${ruleId}:${digest}`;
}

/** Normalize free-text scope values (e.g. failure topics) before fingerprinting. */
export function normalizeScopeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
