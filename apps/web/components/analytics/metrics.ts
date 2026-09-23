/**
 * Pure helpers for the CS Lead operations pages (analytics, escalation
 * reasons, queues). Client-safe; no invented values — `null` in means "—" out.
 */
import { formatDuration, formatNumber, formatPercent } from '../../lib/format';

export const WINDOW_OPTIONS = [
  { days: 1, label: '24h', long: 'last 24 hours' },
  { days: 7, label: '7d', long: 'last 7 days' },
  { days: 30, label: '30d', long: 'last 30 days' },
  { days: 90, label: '90d', long: 'last 90 days' },
] as const;
export type WindowDays = (typeof WINDOW_OPTIONS)[number]['days'];

/** `?days=` → one of the offered windows (the API accepts 1–90); anything else is 7. */
export function parseDays(value: string | undefined): WindowDays {
  const n = Number(value);
  return WINDOW_OPTIONS.find((o) => o.days === n)?.days ?? 7;
}

export function windowLabel(days: number): string {
  return WINDOW_OPTIONS.find((o) => o.days === days)?.long ?? `last ${days} days`;
}

/** Rates move in percentage points: 0.186 vs 0.168 → "+1.8pt". */
export function rateDelta(value: number | null, previous: number | null): string | null {
  if (value === null || previous === null) return null;
  const pt = (value - previous) * 100;
  if (Math.abs(pt) < 0.05) return '±0pt';
  return `${pt > 0 ? '+' : '−'}${Math.abs(pt).toFixed(1)}pt`;
}

/** Counts move relatively: 4812 vs 4531 → "+6.2%". No previous volume → no delta. */
export function countDelta(value: number, previous: number): string | null {
  if (previous <= 0) return null;
  const pct = ((value - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return '±0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

/** Durations move in their own unit: 4.2s vs 3.1s → "+1s". */
export function durationDelta(value: number | null, previous: number | null): string | null {
  if (value === null || previous === null) return null;
  const diff = Math.round(value - previous);
  if (diff === 0) return '±0s';
  return `${diff > 0 ? '+' : '−'}${formatDuration(Math.abs(diff))}`;
}

/** CSAT means move in points on the 1–5 scale. */
export function scoreDelta(value: number | null, previous: number | null): string | null {
  if (value === null || previous === null) return null;
  const diff = value - previous;
  if (Math.abs(diff) < 0.005) return '±0.00';
  return `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(2)}`;
}

/** Cost in micros of `currency` (ISO code, or MIXED/null when it cannot be priced as one amount). */
export function formatMoneyMicros(micros: number | null, currency: string | null): string {
  if (micros === null) return '—';
  const amount = micros / 1_000_000;
  if (!currency || currency === 'MIXED') return `${formatNumber(amount, 4)}${currency ? ' (mixed currencies)' : ''}`;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount);
  } catch {
    return `${formatNumber(amount, 4)} ${currency}`;
  }
}

/** `customer_request` / `CUSTOMER_REQUEST` → "Customer request". */
export function humanizeCode(code: string): string {
  const words = code.replace(/[_\-.]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

export { formatDuration, formatNumber, formatPercent };

/**
 * Numbered footnotes for metric definitions: each distinct definition gets
 * one number in first-seen order, so identical formulas share a footnote.
 */
export class Footnotes {
  private readonly order: string[] = [];

  ref(definition: string): number {
    const at = this.order.indexOf(definition);
    if (at >= 0) return at + 1;
    this.order.push(definition);
    return this.order.length;
  }

  list(): Array<{ n: number; text: string }> {
    return this.order.map((text, i) => ({ n: i + 1, text }));
  }
}

export interface ReasonSeries {
  reasonCode: string;
  values: number[];
}

/**
 * Per-day counts for the `top` reason codes (by window total) plus an "other"
 * series for the rest, aligned to the daily buckets.
 */
export function reasonSeries(daily: ReadonlyArray<{ byReason: Record<string, number>; total: number }>, codesByVolume: readonly string[], top = 4): ReasonSeries[] {
  const chosen = [...new Set(codesByVolume)].slice(0, top);
  const series = chosen.map((code) => ({ reasonCode: code, values: daily.map((d) => d.byReason[code] ?? 0) }));
  const other = daily.map((d) => d.total - chosen.reduce((s, code) => s + (d.byReason[code] ?? 0), 0));
  if (other.some((v) => v > 0)) series.push({ reasonCode: 'other', values: other });
  return series;
}

/** Share of `part` in `whole` as a 0–1 bar length (0 when there is no whole). */
export function share(part: number, whole: number): number {
  return whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
}

/** Stable footnote numbers for a page's metrics, computed before rendering. */
export function numberNotes(entries: ReadonlyArray<readonly [key: string, definition: string]>): { refs: Record<string, number>; list: Array<{ n: number; text: string }> } {
  const notes = new Footnotes();
  const refs: Record<string, number> = {};
  for (const [key, definition] of entries) refs[key] = notes.ref(definition);
  return { refs, list: notes.list() };
}

/** Calendar day (YYYY-MM-DD) of an instant in a timezone, to place markers on daily series. */
export function dayKey(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-14" → "14 Sep" (fixed English month names, as the design writes them). */
export function shortDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${m[3]} ${month}` : day;
}

/**
 * Display labels for (reasonCode, trigger) groups: the humanized code, with
 * the trigger added only where two groups would otherwise read the same.
 */
export function reasonLabels(reasons: ReadonlyArray<{ reasonCode: string; trigger: string }>): string[] {
  const base = reasons.map((r) => humanizeCode(r.reasonCode));
  return base.map((label, i) => (base.indexOf(label) !== base.lastIndexOf(label) ? `${label} · ${humanizeCode(reasons[i]!.trigger)}` : label));
}
