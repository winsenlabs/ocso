/**
 * Quiet AI conversations (a core channel setting on every kind): an AI-handled conversation with no new messages
 * for `aiIdleResolveHours` is resolved, so the customer's next message goes through the channel's router again.
 * 0 = never. Conversations a person holds are never resolved this way.
 */
export const AI_IDLE_SETTING = 'aiIdleResolveHours';
export const AI_IDLE_DEFAULT_HOURS = 24;
export const AI_IDLE_MAX_HOURS = 720;
/** The disposition of a conversation resolved for being quiet; it never reopens: the next message is routed afresh. */
export const IDLE_DISPOSITION = 'AI_IDLE';

export const isAiIdleHours = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= AI_IDLE_MAX_HOURS;

/** The channel's quiet period in hours (0 = never): its setting when valid, else the default. */
export function aiIdleHoursOf(settings: Readonly<Record<string, unknown>> | null | undefined): number {
  const v = settings?.[AI_IDLE_SETTING];
  return isAiIdleHours(v) ? v : AI_IDLE_DEFAULT_HOURS;
}
