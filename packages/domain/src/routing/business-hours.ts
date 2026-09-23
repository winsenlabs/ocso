import { z } from 'zod';

/**
 * Agent business hours (docs/01 §4, docs/09 §3). The AI answers 24×7;
 * `humanHours` only says when people are available to take handoffs.
 * An empty `humanHours` means humans are available 24×7.
 *
 * Pure and timezone/DST-correct: every local-time question is answered with
 * Intl in the agent's IANA time zone, never with the host's local time.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Stored shape (virtual_agents.business_hours); `humanHours` keys are weekdays. */
export interface BusinessHoursLike {
  timezone: string;
  humanHours: Readonly<Record<string, readonly [string, string]>>;
}

const OPEN_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** Closing may also be 24:00 (end of the day). */
const CLOSE_TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

const zoneValidity = new Map<string, boolean>();

/** IANA zone name Intl understands ("Asia/Kolkata", "UTC"); rejects raw offsets such as "+05:30". */
export function isValidTimeZone(zone: string): boolean {
  if (zone.length > 64 || !ZONE_NAME.test(zone)) return false;
  let valid = zoneValidity.get(zone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
    if (zoneValidity.size < 1_000) zoneValidity.set(zone, valid);
  }
  return valid;
}

/** "HH:MM" → minutes after local midnight (24:00 → 1440). */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

const DaySpan = z.tuple(
  [z.string().regex(OPEN_TIME, 'Opening time must be HH:MM (24-hour, 00:00–23:59)'), z.string().regex(CLOSE_TIME, 'Closing time must be HH:MM (24-hour, up to 24:00)')],
  { error: 'Give an opening and a closing time' },
);

/** API input contract; path-addressed issues (e.g. humanHours.mon) so a form can show them inline. */
export const BusinessHoursSchema = z
  .object({
    timezone: z.string().trim().refine(isValidTimeZone, 'Unknown time zone: use an IANA name such as Asia/Kolkata'),
    humanHours: z.partialRecord(z.enum(WEEKDAYS), DaySpan, {
      // Enum-keyed records report extra keys as `unrecognized_keys` (not in the record issue type).
      error: (issue) => {
        const { code, keys } = issue as { code: string; keys?: string[] };
        return code === 'unrecognized_keys' ? `Unknown day ${(keys ?? []).join(', ')}: use mon, tue, wed, thu, fri, sat or sun` : undefined;
      },
    }),
  })
  .superRefine((value, ctx) => {
    for (const day of WEEKDAYS) {
      const span = value.humanHours[day];
      if (span && OPEN_TIME.test(span[0]) && CLOSE_TIME.test(span[1]) && minutesOf(span[0]) >= minutesOf(span[1])) {
        ctx.addIssue({ code: 'custom', path: ['humanHours', day], message: 'Opening time must be before closing time' });
      }
    }
  });
export type BusinessHoursInput = z.infer<typeof BusinessHoursSchema>;

/** Humans available around the clock (no hours configured). */
export function isAlwaysOpen(hours: BusinessHoursLike): boolean {
  return Object.keys(hours.humanHours).length === 0;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: Weekday;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_OF: Readonly<Record<string, Weekday>> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

/** Stored zones are validated on write; anything unusable falls back to UTC rather than throwing at runtime. */
function zoneOf(hours: BusinessHoursLike): string {
  return isValidTimeZone(hours.timezone) ? hours.timezone : 'UTC';
}

function localParts(instant: number, zone: string): LocalParts {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(instant))) p[part.type] = part.value;
  return {
    year: Number(p['year']),
    month: Number(p['month']),
    day: Number(p['day']),
    weekday: WEEKDAY_OF[p['weekday'] ?? ''] ?? 'mon',
    hour: Number(p['hour']) % 24,
    minute: Number(p['minute']),
    second: Number(p['second']),
  };
}

/** UTC offset (ms, local − UTC) of `zone` at `instant`. */
function offsetAt(instant: number, zone: string): number {
  const p = localParts(instant, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * Every instant a local wall-clock time occurs in `zone`, earliest first: one
 * normally, two on a DST fall-back night; for a time skipped by a
 * spring-forward gap, the single instant shifted forward by the gap (like
 * Temporal's "compatible" disambiguation).
 */
function wallInstants(zone: string, year: number, month: number, day: number, hour: number, minute: number): number[] {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = wall - offsetAt(wall - 86_400_000, zone);
  const after = wall - offsetAt(wall + 86_400_000, zone);
  const matches = [...new Set([before, after])]
    .filter((t) => {
      const p = localParts(t, zone);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
    })
    .sort((a, b) => a - b);
  return matches.length ? matches : [before];
}

/** The (first) instant a local wall-clock time occurs in `zone`. */
export function zonedTime(zone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(wallInstants(zone, year, month, day, hour, minute)[0]!);
}

/** Whether humans are available at `at` (always true when no hours are configured). */
export function isWithinHours(hours: BusinessHoursLike, at: Date): boolean {
  if (isAlwaysOpen(hours)) return true;
  const local = localParts(at.getTime(), zoneOf(hours));
  const span = hours.humanHours[local.weekday];
  if (!span) return false;
  const minute = local.hour * 60 + local.minute;
  return minutesOf(span[0]) <= minute && minute < minutesOf(span[1]);
}

/**
 * When humans are next available: `at` itself when within hours (or always
 * open), otherwise the next opening instant. Null only when the stored hours
 * have no usable day (never for validated input).
 */
export function nextOpening(hours: BusinessHoursLike, at: Date): Date | null {
  if (isWithinHours(hours, at)) return at;
  const zone = zoneOf(hours);
  const today = localParts(at.getTime(), zone);
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = WEEKDAYS[(date.getUTCDay() + 6) % 7]!;
    const span = hours.humanHours[weekday];
    if (!span || !OPEN_TIME.test(span[0])) continue;
    const open = minutesOf(span[0]);
    const instants = wallInstants(zone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(open / 60), open % 60);
    const opening = instants.find((t) => t > at.getTime());
    if (opening !== undefined) return new Date(opening);
  }
  return null;
}

/** "Monday 28 Sep, 08:00 GMT+5:30" — an opening as a customer reads it, in the agent's zone. */
export function formatOpening(at: Date, timezone: string): string {
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  const p: Record<string, string> = {};
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(at);
  for (const part of parts) p[part.type] = part.value;
  const hour = String(Number(p['hour']) % 24).padStart(2, '0');
  return `${p['weekday']} ${p['day']} ${p['month']}, ${hour}:${p['minute']} ${p['timeZoneName']}`;
}
