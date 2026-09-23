import { isValidTimeZone, zonedTime } from '@ocso/domain';

/**
 * Report periods (PM/research/11 §7): a weekly report covers Monday 00:00 to
 * the next Monday 00:00 in the deployment's time zone (a DST week is 167 or 169
 * hours). The live view looks back LIVE_WINDOW_DAYS for events.
 */

export const LIVE_WINDOW_DAYS = 7;
/** Ad-hoc reports: at most this long, and not reaching further back than the audit local window's floor. */
export const ADHOC_MAX_DAYS = 31;
export const ADHOC_LOOKBACK_DAYS = 90;

export interface Period {
  start: Date;
  end: Date;
}

function localDate(instant: Date, zone: string): { year: number; month: number; day: number; weekday: number } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(instant)) {
    parts[p.type] = p.value;
  }
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts['weekday'] ?? 'Mon');
  return { year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']), weekday: Math.max(0, weekday) };
}

/** Local midnight of a calendar date `offsetDays` from (year, month, day), in `zone`. */
function midnight(zone: string, year: number, month: number, day: number, offsetDays: number): Date {
  const d = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return zonedTime(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0);
}

export function safeZone(zone: string | null | undefined): string {
  return zone && isValidTimeZone(zone) ? zone : 'UTC';
}

/** The last complete Monday-to-Monday week before `now`, in `zone`. */
export function lastCompleteWeek(now: Date, zone: string): Period {
  const tz = safeZone(zone);
  const today = localDate(now, tz);
  const end = midnight(tz, today.year, today.month, today.day, -today.weekday);
  const start = midnight(tz, today.year, today.month, today.day, -today.weekday - 7);
  return { start, end };
}

/**
 * The weekly period that follows one ending at `start`: it ends at the first Monday 00:00 (in `zone`) at
 * least a day after `start`. Weekly periods chain end to start, so a week is never skipped or covered twice:
 * after a time-zone change the first period is a shorter or longer bridge (one to eight days) to the new
 * zone's Monday.
 */
export function weekAfter(start: Date, zone: string): Period {
  const tz = safeZone(zone);
  const from = localDate(new Date(start.getTime() + 86_400_000), tz);
  let end = midnight(tz, from.year, from.month, from.day, (7 - from.weekday) % 7);
  if (end.getTime() < start.getTime() + 86_400_000) end = midnight(tz, from.year, from.month, from.day, 7 - from.weekday);
  return { start, end };
}

export function liveWindow(now: Date): Period {
  return { start: new Date(now.getTime() - LIVE_WINDOW_DAYS * 86_400_000), end: now };
}

/** The canonical text of a period inside the signed message. */
export function periodText(p: Period): string {
  return `${p.start.toISOString()}/${p.end.toISOString()}`;
}
