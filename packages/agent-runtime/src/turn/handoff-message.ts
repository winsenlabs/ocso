import { formatOpening, type BusinessHoursLike } from '@ocso/domain';
import { humanAvailability } from '@ocso/application';

export const DEFAULT_HANDOFF_MESSAGE = "I've asked a colleague to help with this. They'll reply here shortly.";
const HANDOFF_QUEUED_MESSAGE = "I've asked a colleague to help with this.";

/**
 * Customer-facing text of a turn that hands off to humans. Inside the agent's
 * human business hours it is the model's reply (or the default). Outside them
 * the AI still answers, but the customer is told when the team is next
 * available, in the agent's time zone: "Our team is next available Monday
 * 28 Sep, 08:00 GMT+5:30 and will reply here then."
 */
export function handoffMessage(modelText: string | null, hours: BusinessHoursLike | null | undefined, now: Date): string {
  const humans = humanAvailability(hours, now);
  if (humans.open || !hours) return modelText ?? DEFAULT_HANDOFF_MESSAGE;
  const base = modelText ?? HANDOFF_QUEUED_MESSAGE;
  const sentence = /[.!?…)"”]$/.test(base) ? base : `${base}.`;
  return `${sentence} Our team is next available ${formatOpening(humans.opensAt, hours.timezone)} and will reply here then.`;
}
