/**
 * Display formatting for the operational UI. Pure functions, no locale
 * guessing: numbers use grouped Latin digits, times render in the
 * deployment's timezone (not the viewer's) so every user sees the same clock.
 */

const EM_DASH = '—';

export function formatNumber(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
}

/** 0.798 → "79.8%". */
export function formatPercent(ratio: number | null | undefined, fractionDigits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EM_DASH;
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

/** 41_200_000 → "41.2M", 6_100 → "6.1K". */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/**
 * Human durations as the design writes them:
 * 4 → "4s", 72 → "1m 12s", 2460 → "41m", 65_520 → "18h 12m", 101_000 → "1d 04h".
 * Minute-level values keep zero-padded seconds ("4m 05s").
 */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return EM_DASH;
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  if (days > 0) return `${days}d ${pad2(hours)}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${pad2(seconds)}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Countdown clock for SLA timers: 252 → "04:12", 3_725 → "1:02:05". Negative values are treated as elapsed. */
export function formatClock(totalSeconds: number): string {
  const s = Math.abs(Math.round(totalSeconds));
  const hours = Math.floor(s / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/** Milliseconds as latency: 780 → "780ms", 2_900 → "2.9s". */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

/** "09:52" in the deployment timezone. */
export function formatTime(iso: string | null | undefined, timeZone: string): string {
  const d = toDate(iso);
  if (!d) return EM_DASH;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: safeZone(timeZone) }).format(d);
}

/** "12 Mar 11:20" in the deployment timezone. */
export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  const d = toDate(iso);
  if (!d) return EM_DASH;
  const zone = safeZone(timeZone);
  const date = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: zone }).format(d);
  return `${date} ${formatTime(iso, zone)}`;
}

/** Age of something that happened at `iso`: "22m", "3h", "2d". */
export function formatAge(iso: string | null | undefined, now: Date = new Date()): string {
  const d = toDate(iso);
  if (!d) return EM_DASH;
  const s = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1_000));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Short zone label, e.g. "IST" / "UTC" / "GMT+4", for shift and time captions. */
export function formatZoneName(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: safeZone(timeZone), timeZoneName: 'short' }).formatToParts(at);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/** "Nikhil Menon" → "NM"; single names give two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  const letters = last ? `${first.charAt(0)}${last.charAt(0)}` : first.slice(0, 2);
  return letters.toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}
