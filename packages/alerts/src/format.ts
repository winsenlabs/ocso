/** Deterministic, locale-independent value formatting for alert titles and bodies. */

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatCount(n: number): string {
  const rounded = Math.round(n);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 850 → "850ms", 2900 → "2.9s", 65000 → "1m 05s". */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Window lengths: 30 → "30s", 300 → "5m", 5400 → "1h 30m", 86400 → "1d". */
export function formatWindow(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return seconds % 60 === 0 ? `${seconds / 60}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Money stored as micro-units (1e-6) → "12.34 USD". */
export function formatMicros(micros: number, currency = 'USD'): string {
  return `${(micros / 1_000_000).toFixed(2)} ${currency}`;
}

/** Ratios such as spike multipliers: 3.456 → "3.5×". */
export function formatMultiplier(ratio: number): string {
  return `${ratio.toFixed(1)}×`;
}
