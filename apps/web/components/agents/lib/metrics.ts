import { formatDuration, formatNumber, formatPercent } from '../../../lib/format';

/**
 * Metric presentation for analytics tiles (docs/11 §3). Deltas compare the
 * same formula over the previous same-length window; null means no data and
 * is never shown as zero. Pure, client-safe.
 */

/** Rate change in percentage points: 0.186 vs 0.168 → "+1.8pt". */
export function pointDelta(value: number | null, previous: number | null): string | null {
  if (value === null || previous === null) return null;
  const pts = (value - previous) * 100;
  if (Math.abs(pts) < 0.05) return '±0pt';
  return `${pts > 0 ? '+' : '−'}${Math.abs(pts).toFixed(1)}pt`;
}

/** Relative change of a count: 4812 vs 4531 → "+6.2%"; no baseline → null. */
export function relativeDelta(value: number | null, previous: number | null): string | null {
  if (value === null || previous === null || previous === 0) return null;
  const pct = ((value - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return '±0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/** Absolute change of a count or a duration in seconds. */
export function absoluteDelta(value: number | null, previous: number | null, unit: 'count' | 'seconds' = 'count'): string | null {
  if (value === null || previous === null) return null;
  const d = value - previous;
  if (d === 0) return '±0';
  const body = unit === 'seconds' ? formatDuration(Math.abs(d)) : formatNumber(Math.abs(d), Number.isInteger(d) ? 0 : 2);
  return `${d > 0 ? '+' : '−'}${body}`;
}

/** Micros of a currency → "₹4.80" / "USD 0.0123" (no FX conversion, ever). */
export function formatMoneyMicros(micros: number | null, currency: string | null): string {
  if (micros === null || currency === null) return '—';
  if (currency === 'MIXED') return 'mixed currencies';
  const value = micros / 1_000_000;
  const digits = value !== 0 && Math.abs(value) < 0.1 ? 4 : 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  } catch {
    return `${currency} ${value.toFixed(digits)}`;
  }
}

export const rate = (v: number | null) => formatPercent(v);

/** Share of a total as a bar length (0–1); an all-zero list gives zero-length bars. */
export function shares<T>(items: readonly T[], count: (item: T) => number): number[] {
  const max = Math.max(0, ...items.map(count));
  return items.map((i) => (max > 0 ? count(i) / max : 0));
}
