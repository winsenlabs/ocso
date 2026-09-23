/**
 * Business-hours editor model (agent Settings tab). The API contract is
 * `{ timezone, humanHours: { mon: ['08:00','23:00'], … } }` with an empty
 * `humanHours` meaning humans 24×7 (the AI always answers 24×7). Pure and
 * client-safe; the API validates and is the source of every field error.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DAY_LABELS: Readonly<Record<Weekday, string>> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export interface BusinessHours {
  timezone: string;
  humanHours: Record<string, [string, string]>;
}

export interface DayForm {
  open: boolean;
  from: string;
  to: string;
}

export interface HoursForm {
  /** Humans available 24×7 (sent as an empty `humanHours`). */
  alwaysOpen: boolean;
  timezone: string;
  days: Record<Weekday, DayForm>;
}

/** Field keys for inline errors: the zone, one day, or the week as a whole. */
export type HoursField = 'timezone' | 'days' | Weekday;
export type HoursIssues = Partial<Record<HoursField, string>>;

const DEFAULT_SPAN: Readonly<Record<Weekday, [string, string]>> = {
  mon: ['09:00', '18:00'],
  tue: ['09:00', '18:00'],
  wed: ['09:00', '18:00'],
  thu: ['09:00', '18:00'],
  fri: ['09:00', '18:00'],
  sat: ['10:00', '16:00'],
  sun: ['10:00', '16:00'],
};

/** Stored hours → editor state. Closed days keep a sensible span ready for when they are switched on. */
export function toForm(hours: BusinessHours): HoursForm {
  const days = Object.fromEntries(
    WEEKDAYS.map((d) => {
      const span = hours.humanHours[d];
      return [d, span ? { open: true, from: span[0], to: span[1] } : { open: false, from: DEFAULT_SPAN[d][0], to: DEFAULT_SPAN[d][1] }];
    }),
  ) as Record<Weekday, DayForm>;
  return { alwaysOpen: Object.keys(hours.humanHours).length === 0, timezone: hours.timezone, days };
}

/** Editor state → API body. 24×7 sends `{}`; otherwise only the open days, in week order. */
export function toInput(form: HoursForm): BusinessHours {
  if (form.alwaysOpen) return { timezone: form.timezone, humanHours: {} };
  const humanHours: Record<string, [string, string]> = {};
  for (const d of WEEKDAYS) if (form.days[d].open) humanHours[d] = [form.days[d].from, form.days[d].to];
  return { timezone: form.timezone, humanHours };
}

/**
 * The one thing the API cannot tell apart: with 24×7 off and no day open the
 * body would be `{}`, which means 24×7. Everything else is left to the API.
 */
export function localIssues(form: HoursForm): HoursIssues {
  if (!form.alwaysOpen && WEEKDAYS.every((d) => !form.days[d].open)) return { days: 'Open at least one day, or switch on humans 24×7.' };
  return {};
}

/**
 * API validation message ("businessHours.humanHours.mon: Opening time must be
 * before closing time; businessHours.timezone: …") → inline field errors.
 * Anything that is not about business hours stays in `other`.
 */
export function hoursIssues(message: string): { fields: HoursIssues; other: string[] } {
  const fields: HoursIssues = {};
  const other: string[] = [];
  for (const part of message.split('; ')) {
    const match = /^businessHours(?:\.(timezone|humanHours)(?:\.(mon|tue|wed|thu|fri|sat|sun))?(?:\.\d+)?)?: (.+)$/.exec(part.trim());
    if (!match) {
      if (part.trim()) other.push(part.trim());
      continue;
    }
    const [, area, day, text] = match;
    const key: HoursField = area === 'timezone' ? 'timezone' : ((day as Weekday | undefined) ?? 'days');
    fields[key] = fields[key] ? `${fields[key]} ${text}` : text!;
  }
  return { fields, other };
}

/** Well-known zones some ICU builds list under older aliases (e.g. Asia/Calcutta). */
const MODERN_ZONES = ['UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Ho_Chi_Minh', 'Asia/Yangon', 'Europe/Kyiv', 'America/Nuuk', 'Atlantic/Faroe'];

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Select options: UTC first, then every supported zone, always including the current value. */
export function timeZoneOptions(current: string, supported: readonly string[]): string[] {
  const zones = new Set([...supported, ...MODERN_ZONES.filter(knownZone), current]);
  zones.delete('UTC');
  return ['UTC', ...[...zones].filter(Boolean).sort((a, b) => a.localeCompare(b))];
}

/** Read-only rows: "Monday · 08:00–23:00" / "closed", or a single 24×7 row. */
export function hoursRows(hours: BusinessHours): Array<{ k: string; v: string }> {
  if (Object.keys(hours.humanHours).length === 0) return [{ k: 'humans', v: '24×7' }];
  return WEEKDAYS.map((d) => {
    const span = hours.humanHours[d];
    return { k: DAY_LABELS[d].toLowerCase(), v: span ? `${span[0]}–${span[1]}` : 'closed' };
  });
}
