import { formatClock } from '../../../lib/format';

/** SLA clock as the UI renders it (SlaTimer). */
export interface SlaView {
  level: 'ok' | 'risk' | 'breach';
  /** Seconds left (negative once breached). */
  remainingSeconds: number;
  /** Elapsed share of the SLA window, 0–1. */
  progress: number;
}

/** Share of the pickup window after which the timer turns amber (docs/09; policy default). */
const AT_RISK_FRACTION = 0.75;

/** Control states in which the pickup SLA clock is running. */
const WAITING_STATES = new Set(['ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN']);

/**
 * Pickup SLA (queue policy, set when a handoff is routed). The clock runs only
 * while the conversation waits for a human; once claimed it is met or missed,
 * so other states show no timer rather than an invented one.
 */
export function pickupSla(
  controlState: string,
  waitingSince: string | null,
  slaDueAt: string | null,
  now: number,
): SlaView | null {
  if (!WAITING_STATES.has(controlState) || !slaDueAt) return null;
  const due = Date.parse(slaDueAt);
  if (!Number.isFinite(due)) return null;
  const start = waitingSince ? Date.parse(waitingSince) : Number.NaN;
  const remainingSeconds = Math.round((due - now) / 1000);
  const window = Number.isFinite(start) && due > start ? due - start : null;
  const progress = window === null ? (remainingSeconds <= 0 ? 1 : 0) : clamp01((now - start) / window);
  const level: SlaView['level'] = remainingSeconds <= 0 ? 'breach' : progress >= AT_RISK_FRACTION ? 'risk' : 'ok';
  return { level, remainingSeconds, progress };
}

/** "04:12 to SLA" / "breached 01:38". */
export function slaLabel(sla: SlaView): string {
  return sla.level === 'breach' ? `breached ${formatClock(sla.remainingSeconds)}` : `${formatClock(sla.remainingSeconds)} to SLA`;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
