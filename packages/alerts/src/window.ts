/** Time-window helpers shared by rule evaluators. All windows are [start, end]. */

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** The evaluation window ending at `now`. */
export function evaluationWindow(now: Date, windowSeconds: number): TimeWindow {
  return { start: new Date(now.getTime() - windowSeconds * 1000), end: now };
}

/**
 * Trailing baseline immediately before the evaluation window: `windows`
 * consecutive windows of the same length. Used by spike/drop evaluators.
 */
export function baselineWindow(now: Date, windowSeconds: number, windows: number): TimeWindow {
  const end = new Date(now.getTime() - windowSeconds * 1000);
  return { start: new Date(end.getTime() - windows * windowSeconds * 1000), end };
}

/** True while a fingerprint resolved at `resolvedAt` must not be reopened. */
export function withinDedupeWindow(resolvedAt: Date | null, now: Date, dedupeWindowSeconds: number): boolean {
  if (!resolvedAt || dedupeWindowSeconds <= 0) return false;
  return now.getTime() - resolvedAt.getTime() < dedupeWindowSeconds * 1000;
}

/** Seconds between two instants, never negative. */
export function ageSeconds(from: Date, now: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / 1000);
}

/** Ratio that is 0 (not NaN/Infinity) when the denominator is 0. */
export function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
