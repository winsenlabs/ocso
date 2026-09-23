import { nextOpening, type BusinessHoursLike } from '@ocso/domain';

export interface HumanAvailability {
  /** Humans are within the agent's business hours now (always true for 24×7). */
  open: boolean;
  /** `now` when open, otherwise the next opening: the start of the pickup SLA clock and of auto-assign offers. */
  opensAt: Date;
}

/**
 * Human availability for a handoff (docs/01 §4, docs/09 §3): the AI answers
 * 24×7; the agent's business hours only say when people can be offered work.
 * Hours with no usable day are treated as open rather than blocking humans.
 */
export function humanAvailability(hours: BusinessHoursLike | null | undefined, now: Date): HumanAvailability {
  const opensAt = hours ? nextOpening(hours, now) : now;
  if (!opensAt || opensAt.getTime() <= now.getTime()) return { open: true, opensAt: now };
  return { open: false, opensAt };
}

/**
 * Whose hours say when humans take handoffs (PM/research/11 §5.5): the
 * queue's when it has its own, else the agent's.
 */
export function effectiveHours(
  queue: { businessHours: BusinessHoursLike | null } | null | undefined,
  agent: { businessHours: BusinessHoursLike } | null | undefined,
): BusinessHoursLike | null {
  return queue?.businessHours ?? agent?.businessHours ?? null;
}
