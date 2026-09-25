import type { ConversationType, Priority } from '../conversation/types.js';

/** SLA policy attached to a queue (docs/archive/specs/09, design/02 Routing tab). */
export interface SlaPolicy {
  firstHumanResponseSeconds: number;
  pickupSecondsByPriority: Readonly<Partial<Record<Priority, number>>>;
  resolutionSecondsByType: Readonly<Partial<Record<ConversationType, number>>>;
  /** Fraction of the window after which the timer shows "at risk". */
  atRiskFraction: number;
}

export type SlaState = 'NONE' | 'OK' | 'AT_RISK' | 'BREACHED' | 'MET' | 'MISSED';

export interface SlaStatus {
  state: SlaState;
  /** Milliseconds remaining (negative once breached). Null when no SLA. */
  remainingMs: number | null;
  /** 0..1+ elapsed fraction for the timer bar. */
  elapsedFraction: number | null;
}

export function pickupDueAt(policy: SlaPolicy, priority: Priority, waitingSince: Date): Date | null {
  const seconds = policy.pickupSecondsByPriority[priority] ?? policy.firstHumanResponseSeconds;
  return seconds > 0 ? new Date(waitingSince.getTime() + seconds * 1000) : null;
}

export function resolutionDueAt(policy: SlaPolicy, type: ConversationType, openedAt: Date): Date | null {
  const seconds = policy.resolutionSecondsByType[type];
  return seconds && seconds > 0 ? new Date(openedAt.getTime() + seconds * 1000) : null;
}

/**
 * Evaluate a single SLA window. `completedAt` set means the obligation was
 * fulfilled (e.g. first human response sent), which yields MET or MISSED.
 */
export function evaluateSla(
  now: Date,
  startedAt: Date,
  dueAt: Date | null,
  completedAt: Date | null,
  atRiskFraction: number,
): SlaStatus {
  if (!dueAt) return { state: 'NONE', remainingMs: null, elapsedFraction: null };
  const windowMs = Math.max(1, dueAt.getTime() - startedAt.getTime());
  const reference = completedAt ?? now;
  const elapsedFraction = (reference.getTime() - startedAt.getTime()) / windowMs;
  const remainingMs = dueAt.getTime() - reference.getTime();
  if (completedAt) {
    return { state: remainingMs >= 0 ? 'MET' : 'MISSED', remainingMs, elapsedFraction };
  }
  if (remainingMs < 0) return { state: 'BREACHED', remainingMs, elapsedFraction };
  if (elapsedFraction >= atRiskFraction) return { state: 'AT_RISK', remainingMs, elapsedFraction };
  return { state: 'OK', remainingMs, elapsedFraction };
}

/** "04:12", "1d 04h", "breached 01:38" style formatting used by the design. */
export function formatSlaRemaining(ms: number): string {
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  return `${pad(minutes)}:${pad(seconds)}`;
}
