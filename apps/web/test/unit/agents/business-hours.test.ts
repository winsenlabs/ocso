import { describe, expect, it } from 'vitest';
import { hoursIssues, hoursRows, localIssues, timeZoneOptions, toForm, toInput } from '../../../components/agents/lib/business-hours';

const STORED = { timezone: 'Asia/Kolkata', humanHours: { mon: ['08:00', '23:00'], sat: ['10:00', '14:00'] } as Record<string, [string, string]> };

describe('business hours form mapping', () => {
  it('maps stored hours to the editor and back without changing them', () => {
    const form = toForm(STORED);
    expect(form.alwaysOpen).toBe(false);
    expect(form.timezone).toBe('Asia/Kolkata');
    expect(form.days.mon).toEqual({ open: true, from: '08:00', to: '23:00' });
    expect(form.days.tue).toEqual({ open: false, from: '09:00', to: '18:00' });
    expect(form.days.sun.open).toBe(false);
    expect(toInput(form)).toEqual(STORED);
  });

  it('treats empty hours as humans 24×7 and sends {} for 24×7', () => {
    const form = toForm({ timezone: 'UTC', humanHours: {} });
    expect(form.alwaysOpen).toBe(true);
    expect(Object.values(form.days).every((d) => !d.open)).toBe(true);
    // Switching 24×7 on drops the day spans, even ones that are ticked.
    const withDays = { ...toForm(STORED), alwaysOpen: true };
    expect(toInput(withDays)).toEqual({ timezone: 'Asia/Kolkata', humanHours: {} });
  });

  it('sends only open days, in week order, with the chosen zone', () => {
    const form = toForm({ timezone: 'UTC', humanHours: {} });
    form.alwaysOpen = false;
    form.timezone = 'Europe/London';
    form.days.fri = { open: true, from: '09:30', to: '17:30' };
    form.days.mon = { open: true, from: '09:00', to: '17:00' };
    form.days.wed = { open: false, from: '01:00', to: '02:00' };
    const input = toInput(form);
    expect(input).toEqual({ timezone: 'Europe/London', humanHours: { mon: ['09:00', '17:00'], fri: ['09:30', '17:30'] } });
    expect(Object.keys(input.humanHours)).toEqual(['mon', 'fri']);
  });

  it('blocks the one ambiguous state locally: no open day with 24×7 off', () => {
    const form = { ...toForm({ timezone: 'UTC', humanHours: {} }), alwaysOpen: false };
    expect(localIssues(form)).toEqual({ days: 'Open at least one day, or switch on humans 24×7.' });
    expect(localIssues(toForm(STORED))).toEqual({});
    expect(localIssues(toForm({ timezone: 'UTC', humanHours: {} }))).toEqual({});
  });
});

describe('API validation errors inline', () => {
  it('maps path-addressed API messages to the zone, a day, or the week', () => {
    const message = [
      'businessHours.timezone: Unknown time zone: use an IANA name such as Asia/Kolkata',
      'businessHours.humanHours.mon: Opening time must be before closing time',
      'businessHours.humanHours.tue.0: Opening time must be HH:MM (24-hour, 00:00–23:59)',
      'businessHours.humanHours.tue.1: Closing time must be HH:MM (24-hour, up to 24:00)',
      'businessHours.humanHours: Unknown day funday: use mon, tue, wed, thu, fri, sat or sun',
    ].join('; ');
    expect(hoursIssues(message)).toEqual({
      fields: {
        timezone: 'Unknown time zone: use an IANA name such as Asia/Kolkata',
        mon: 'Opening time must be before closing time',
        tue: 'Opening time must be HH:MM (24-hour, 00:00–23:59) Closing time must be HH:MM (24-hour, up to 24:00)',
        days: 'Unknown day funday: use mon, tue, wed, thu, fri, sat or sun',
      },
      other: [],
    });
  });

  it('keeps errors that are not about hours as a banner message', () => {
    expect(hoursIssues('Your role cannot change business hours.')).toEqual({ fields: {}, other: ['Your role cannot change business hours.'] });
    expect(hoursIssues('name: Too big; businessHours.timezone: Unknown time zone')).toEqual({ fields: { timezone: 'Unknown time zone' }, other: ['name: Too big'] });
  });
});

describe('time zone options and read-only rows', () => {
  it('lists UTC first, keeps the current zone and adds modern names missing from older ICU data', () => {
    const options = timeZoneOptions('Mars/Legacy_Stored', ['Europe/London', 'Asia/Calcutta', 'America/New_York']);
    expect(options[0]).toBe('UTC');
    expect(options).toContain('Asia/Kolkata');
    expect(options).toContain('Asia/Calcutta');
    expect(options).toContain('Mars/Legacy_Stored');
    expect(options.filter((z) => z === 'UTC')).toHaveLength(1);
    expect(options.slice(1)).toEqual([...options.slice(1)].sort((a, b) => a.localeCompare(b)));
  });

  it('describes hours day by day, or as humans 24×7', () => {
    expect(hoursRows({ timezone: 'UTC', humanHours: {} })).toEqual([{ k: 'humans', v: '24×7' }]);
    const rows = hoursRows(STORED);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ k: 'monday', v: '08:00–23:00' });
    expect(rows[1]).toEqual({ k: 'tuesday', v: 'closed' });
    expect(rows[5]).toEqual({ k: 'saturday', v: '10:00–14:00' });
  });
});
