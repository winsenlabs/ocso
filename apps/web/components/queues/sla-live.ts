/**
 * Live pickup-SLA state of waiting conversations (pure, client-safe).
 * The API stores `sla_due_at` when a handoff is routed to a queue with an SLA
 * policy (packages/domain sla.ts pickupDueAt); "at risk" uses that queue's
 * policy `atRiskFraction` (the same rule as domain evaluateSla).
 */

export type LiveSlaLevel = 'breach' | 'risk' | 'ok' | 'none';

export interface LiveSla {
  level: LiveSlaLevel;
  /** Seconds left; negative once breached; null without an SLA. */
  remainingSeconds: number | null;
  /** Elapsed share of the pickup window, 0–1 (null without an SLA). */
  progress: number | null;
}

const WAITING = new Set(['ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN']);

export function liveSla(c: { controlState: string; waitingSince: string | null; slaDueAt: string | null }, atRiskFraction: number, now: number): LiveSla {
  if (!WAITING.has(c.controlState) || !c.slaDueAt) return { level: 'none', remainingSeconds: null, progress: null };
  const due = Date.parse(c.slaDueAt);
  if (!Number.isFinite(due)) return { level: 'none', remainingSeconds: null, progress: null };
  const start = c.waitingSince ? Date.parse(c.waitingSince) : Number.NaN;
  const remainingSeconds = Math.round((due - now) / 1000);
  const window = Number.isFinite(start) && due > start ? due - start : null;
  const progress = window === null ? (remainingSeconds <= 0 ? 1 : 0) : Math.min(1, Math.max(0, (now - start) / window));
  const level: LiveSlaLevel = remainingSeconds < 0 ? 'breach' : progress >= atRiskFraction ? 'risk' : 'ok';
  return { level, remainingSeconds, progress };
}

export interface SlaCounts {
  waiting: number;
  withSla: number;
  risk: number;
  breach: number;
}

/** Waiting conversations sorted most urgent first (breached, then at risk by remaining time, then the rest). */
export function rankBySla<T extends { sla: LiveSla }>(rows: readonly T[]): T[] {
  const weight = { breach: 0, risk: 1, ok: 2, none: 3 } as const;
  return [...rows].sort((a, b) => weight[a.sla.level] - weight[b.sla.level] || (a.sla.remainingSeconds ?? Infinity) - (b.sla.remainingSeconds ?? Infinity));
}

export function countSla(rows: ReadonlyArray<{ sla: LiveSla }>): SlaCounts {
  return {
    waiting: rows.length,
    withSla: rows.filter((r) => r.sla.level !== 'none').length,
    risk: rows.filter((r) => r.sla.level === 'risk').length,
    breach: rows.filter((r) => r.sla.level === 'breach').length,
  };
}
