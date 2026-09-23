import type { AlertSeverity } from './contract.js';

/** Severity ordering: higher rank = more severe. */
export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> = {
  INFO: 'Info',
  WARNING: 'Warning',
  CRITICAL: 'Critical',
};

/** Negative when `a` is less severe than `b` (sort ascending by severity). */
export function compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function atLeastSeverity(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

export function maxSeverity(severities: readonly AlertSeverity[]): AlertSeverity | null {
  return severities.reduce<AlertSeverity | null>((max, s) => (max === null || compareSeverity(s, max) > 0 ? s : max), null);
}

/** Most severe first — the order alert lists and badges use. */
export function sortBySeverityDesc<T extends { severity: AlertSeverity }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareSeverity(b.severity, a.severity));
}
