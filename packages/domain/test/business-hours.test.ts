import { describe, expect, it } from 'vitest';
import { BusinessHoursSchema, formatOpening, isAlwaysOpen, isValidTimeZone, isWithinHours, nextOpening, zonedTime, type BusinessHoursLike } from '../src/index.js';

const at = (iso: string) => new Date(iso);
const WEEKDAYS_8_23 = { mon: ['08:00', '23:00'], tue: ['08:00', '23:00'], wed: ['08:00', '23:00'], thu: ['08:00', '23:00'], fri: ['08:00', '23:00'] } as const;
const kolkata: BusinessHoursLike = { timezone: 'Asia/Kolkata', humanHours: WEEKDAYS_8_23 };
const newYork: BusinessHoursLike = { timezone: 'America/New_York', humanHours: { mon: ['09:00', '17:00'], sun: ['01:30', '03:00'] } };
const always: BusinessHoursLike = { timezone: 'Asia/Kolkata', humanHours: {} };

const issues = (value: unknown) => {
  const r = BusinessHoursSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('business hours validation', () => {
  it('accepts IANA zones, 24-hour spans, 24:00 closing and empty hours (24×7)', () => {
    expect(issues({ timezone: 'Asia/Kolkata', humanHours: WEEKDAYS_8_23 })).toEqual([]);
    expect(issues({ timezone: 'UTC', humanHours: {} })).toEqual([]);
    expect(issues({ timezone: 'Europe/London', humanHours: { sat: ['00:00', '24:00'] } })).toEqual([]);
    expect(BusinessHoursSchema.parse({ timezone: '  America/New_York ', humanHours: {} }).timezone).toBe('America/New_York');
  });

  it('knows real time zones and rejects offsets, unknown and malformed names', () => {
    for (const z of ['UTC', 'Asia/Kolkata', 'Asia/Calcutta', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5', 'Europe/London']) expect(isValidTimeZone(z)).toBe(true);
    for (const z of ['', '+05:30', 'GMT+05:30', 'Mars/Olympus_Mons', '../etc/passwd', 'Asia//Kolkata', 'x'.repeat(80)]) expect(isValidTimeZone(z)).toBe(false);
    expect(issues({ timezone: 'Mars/Olympus_Mons', humanHours: {} })).toEqual(['timezone: Unknown time zone: use an IANA name such as Asia/Kolkata']);
  });

  it('reports malformed times, reversed spans and unknown days by path', () => {
    expect(issues({ timezone: 'UTC', humanHours: { mon: ['8:00', '17:00'] } })).toEqual(['humanHours.mon.0: Opening time must be HH:MM (24-hour, 00:00–23:59)']);
    expect(issues({ timezone: 'UTC', humanHours: { tue: ['09:00', '25:00'] } })).toEqual(['humanHours.tue.1: Closing time must be HH:MM (24-hour, up to 24:00)']);
    expect(issues({ timezone: 'UTC', humanHours: { wed: ['24:00', '24:00'] } })).toEqual(['humanHours.wed.0: Opening time must be HH:MM (24-hour, 00:00–23:59)']);
    expect(issues({ timezone: 'UTC', humanHours: { thu: ['12:60', '13:00'] } })).toHaveLength(1);
    expect(issues({ timezone: 'UTC', humanHours: { fri: ['18:00', '09:00'] }, extra: 1 })).toEqual(['humanHours.fri: Opening time must be before closing time']);
    expect(issues({ timezone: 'UTC', humanHours: { sat: ['09:00', '09:00'] } })).toEqual(['humanHours.sat: Opening time must be before closing time']);
    expect(issues({ timezone: 'UTC', humanHours: { funday: ['09:00', '17:00'] } })).toEqual(['humanHours: Unknown day funday: use mon, tue, wed, thu, fri, sat or sun']);
    expect(issues({ timezone: 'UTC', humanHours: { sun: ['09:00'] } })).toEqual(['humanHours.sun: Give an opening and a closing time']);
  });
});

describe('isWithinHours', () => {
  it('treats empty hours as humans 24×7', () => {
    expect(isAlwaysOpen(always)).toBe(true);
    expect(isWithinHours(always, at('2026-09-27T21:00:00Z'))).toBe(true);
    expect(nextOpening(always, at('2026-09-27T21:00:00Z'))).toEqual(at('2026-09-27T21:00:00Z'));
  });

  it('uses local wall time in the agent zone: open inclusive, close exclusive', () => {
    // Monday 21 Sep 2026 in IST (UTC+5:30).
    expect(isWithinHours(kolkata, at('2026-09-21T02:29:59Z'))).toBe(false); // 07:59:59
    expect(isWithinHours(kolkata, at('2026-09-21T02:30:00Z'))).toBe(true); // 08:00
    expect(isWithinHours(kolkata, at('2026-09-21T17:29:59Z'))).toBe(true); // 22:59:59
    expect(isWithinHours(kolkata, at('2026-09-21T17:30:00Z'))).toBe(false); // 23:00
    // Saturday and Sunday have no hours.
    expect(isWithinHours(kolkata, at('2026-09-26T06:00:00Z'))).toBe(false);
  });

  it('takes the weekday from the agent zone, not UTC', () => {
    const mondayOnly: BusinessHoursLike = { timezone: 'Asia/Kolkata', humanHours: { mon: ['00:00', '24:00'] } };
    // Sunday 19:00 UTC is already Monday 00:30 in India.
    expect(isWithinHours(mondayOnly, at('2026-09-20T19:00:00Z'))).toBe(true);
    // Monday 19:00 UTC is Tuesday 00:30 in India.
    expect(isWithinHours(mondayOnly, at('2026-09-21T19:00:00Z'))).toBe(false);
    expect(isWithinHours(mondayOnly, at('2026-09-21T18:29:00Z'))).toBe(true); // 23:59 Monday IST
  });

  it('follows daylight saving time', () => {
    const nineToFive: BusinessHoursLike = { timezone: 'America/New_York', humanHours: { mon: ['09:00', '17:00'] } };
    // Before DST (EST, UTC−5).
    expect(isWithinHours(nineToFive, at('2026-03-02T13:59:00Z'))).toBe(false);
    expect(isWithinHours(nineToFive, at('2026-03-02T14:00:00Z'))).toBe(true);
    // After spring-forward on 8 Mar (EDT, UTC−4).
    expect(isWithinHours(nineToFive, at('2026-03-09T12:59:00Z'))).toBe(false);
    expect(isWithinHours(nineToFive, at('2026-03-09T13:00:00Z'))).toBe(true);
    expect(isWithinHours(nineToFive, at('2026-03-09T20:59:00Z'))).toBe(true);
    expect(isWithinHours(nineToFive, at('2026-03-09T21:00:00Z'))).toBe(false);
    // Fall-back night 1 Nov: 01:30–03:00 local spans both 01:30 EDT and 01:30 EST.
    expect(isWithinHours(newYork, at('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
    expect(isWithinHours(newYork, at('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 EST
    expect(isWithinHours(newYork, at('2026-11-01T07:59:00Z'))).toBe(true); // 02:59 EST
    expect(isWithinHours(newYork, at('2026-11-01T08:00:00Z'))).toBe(false); // 03:00 EST
  });

  it('falls back to UTC for an unusable stored zone instead of throwing', () => {
    const broken: BusinessHoursLike = { timezone: 'Not/AZone', humanHours: { mon: ['09:00', '17:00'] } };
    expect(isWithinHours(broken, at('2026-09-21T09:00:00Z'))).toBe(true);
    expect(isWithinHours(broken, at('2026-09-21T17:00:00Z'))).toBe(false);
  });
});

describe('nextOpening', () => {
  it('returns the instant itself while humans are available', () => {
    const now = at('2026-09-21T10:00:00Z');
    expect(nextOpening(kolkata, now)).toBe(now);
  });

  it('finds the same-day opening, the next day, and skips closed days', () => {
    expect(nextOpening(kolkata, at('2026-09-21T01:00:00Z'))).toEqual(at('2026-09-21T02:30:00Z')); // Mon 06:30 → 08:00
    expect(nextOpening(kolkata, at('2026-09-21T18:00:00Z'))).toEqual(at('2026-09-22T02:30:00Z')); // Mon 23:30 → Tue 08:00
    expect(nextOpening(kolkata, at('2026-09-25T18:00:00Z'))).toEqual(at('2026-09-28T02:30:00Z')); // Fri 23:30 → Mon 08:00
    expect(nextOpening(kolkata, at('2026-09-26T12:00:00Z'))).toEqual(at('2026-09-28T02:30:00Z')); // Sat → Mon
  });

  it('wraps a full week when only today is open and it has closed', () => {
    const mondays: BusinessHoursLike = { timezone: 'UTC', humanHours: { mon: ['09:00', '10:00'] } };
    expect(nextOpening(mondays, at('2026-09-21T10:00:00Z'))).toEqual(at('2026-09-28T09:00:00Z'));
  });

  it('resolves openings across DST transitions', () => {
    // Saturday 7 Mar (EST) → Monday 9 Mar 09:00 EDT = 13:00Z, not 14:00Z.
    expect(nextOpening({ timezone: 'America/New_York', humanHours: { mon: ['09:00', '17:00'] } }, at('2026-03-07T17:00:00Z'))).toEqual(at('2026-03-09T13:00:00Z'));
    // An opening inside the spring-forward gap (02:30 does not exist on 8 Mar) moves forward to 03:30 EDT.
    const gap: BusinessHoursLike = { timezone: 'America/New_York', humanHours: { sun: ['02:30', '05:00'] } };
    expect(nextOpening(gap, at('2026-03-07T17:00:00Z'))).toEqual(at('2026-03-08T07:30:00Z'));
    // A repeated time on the fall-back night resolves to its first occurrence (01:30 EDT)…
    expect(nextOpening(newYork, at('2026-11-01T05:00:00Z'))).toEqual(at('2026-11-01T05:30:00Z'));
    // …and after the clocks go back (01:00 EST) the second 01:30 is still ahead that night.
    expect(nextOpening(newYork, at('2026-11-01T06:00:00Z'))).toEqual(at('2026-11-01T06:30:00Z'));
    // London spring-forward (29 Mar): Monday 09:00 BST = 08:00Z.
    expect(nextOpening({ timezone: 'Europe/London', humanHours: { mon: ['09:00', '17:30'] } }, at('2026-03-28T12:00:00Z'))).toEqual(at('2026-03-30T08:00:00Z'));
  });

  it('always lands on an instant that is open, right after one that is not', () => {
    const london: BusinessHoursLike = { timezone: 'Europe/London', humanHours: { tue: ['00:00', '01:00'], sat: ['23:30', '24:00'] } };
    for (const hours of [kolkata, newYork, london]) {
      for (let t = Date.parse('2026-10-24T00:00:00Z'); t < Date.parse('2026-11-08T00:00:00Z'); t += 97 * 60_000) {
        const from = new Date(t);
        const opening = nextOpening(hours, from)!;
        expect(opening.getTime()).toBeGreaterThanOrEqual(t);
        expect(isWithinHours(hours, opening)).toBe(true);
        if (opening.getTime() > t) expect(isWithinHours(hours, new Date(opening.getTime() - 60_000))).toBe(false);
      }
    }
  });

  it('returns null only for stored hours with no usable day', () => {
    expect(nextOpening({ timezone: 'UTC', humanHours: { someday: ['09:00', '17:00'] } }, at('2026-09-21T10:00:00Z'))).toBeNull();
  });
});

describe('zonedTime and formatOpening', () => {
  it('maps local wall time to the instant', () => {
    expect(zonedTime('Asia/Kolkata', 2026, 9, 28, 8, 0)).toEqual(at('2026-09-28T02:30:00Z'));
    expect(zonedTime('UTC', 2026, 12, 31, 23, 59)).toEqual(at('2026-12-31T23:59:00Z'));
    expect(zonedTime('Australia/Lord_Howe', 2026, 7, 1, 9, 0)).toEqual(at('2026-06-30T22:30:00Z')); // UTC+10:30
  });

  it('formats an opening as the customer reads it, in the agent zone', () => {
    expect(formatOpening(at('2026-09-28T02:30:00Z'), 'Asia/Kolkata')).toBe('Monday 28 Sep, 08:00 GMT+5:30');
    expect(formatOpening(at('2026-03-09T13:00:00Z'), 'America/New_York')).toBe('Monday 9 Mar, 09:00 EDT');
    expect(formatOpening(at('2026-03-09T13:00:00Z'), 'UTC')).toBe('Monday 9 Mar, 13:00 UTC');
    expect(formatOpening(at('2026-03-09T00:05:00Z'), 'Bad/Zone')).toBe('Monday 9 Mar, 00:05 UTC');
  });
});
