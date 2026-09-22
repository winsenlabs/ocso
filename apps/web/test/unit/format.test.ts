import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatClock,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatNumber,
  formatPercent,
  formatTime,
  initials,
} from '../../lib/format';
import { safeNextPath, sessionCookieOptions } from '../../lib/session-cookie';

describe('format', () => {
  it('formats durations the way the design writes them', () => {
    expect(formatDuration(4)).toBe('4s');
    expect(formatDuration(72)).toBe('1m 12s');
    expect(formatDuration(2460)).toBe('41m');
    expect(formatDuration(65_520)).toBe('18h 12m');
    expect(formatDuration(101_000)).toBe('1d 04h');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats SLA clocks, latency, numbers and ratios', () => {
    expect(formatClock(252)).toBe('04:12');
    expect(formatClock(-98)).toBe('01:38');
    expect(formatClock(3_725)).toBe('1:02:05');
    expect(formatLatency(780)).toBe('780ms');
    expect(formatLatency(2_900)).toBe('2.9s');
    expect(formatNumber(7204)).toBe('7,204');
    expect(formatPercent(0.798)).toBe('79.8%');
    expect(formatCompact(41_200_000)).toBe('41.2M');
  });

  it('renders times in the deployment timezone, not the viewer’s', () => {
    expect(formatTime('2026-09-22T04:22:00Z', 'Asia/Kolkata')).toBe('09:52');
    expect(formatTime('2026-09-22T04:22:00Z', 'UTC')).toBe('04:22');
    expect(formatDateTime('2026-03-12T05:50:00Z', 'Asia/Kolkata')).toBe('12 Mar 11:20');
    expect(formatTime('2026-09-22T04:22:00Z', 'Not/AZone')).toBe('04:22');
  });

  it('formats ages and initials', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    expect(formatAge('2026-09-22T09:38:00Z', now)).toBe('22m');
    expect(formatAge('2026-09-20T10:00:00Z', now)).toBe('2d');
    expect(initials('Nikhil Menon')).toBe('NM');
    expect(initials('Maya')).toBe('MA');
  });
});

describe('session cookie', () => {
  it('only accepts same-origin relative return paths', () => {
    expect(safeNextPath('/team?x=1')).toBe('/team?x=1');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });

  it('is httpOnly, lax, path=/ and expires with the API session', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    const opts = sessionCookieOptions('2026-09-22T12:00:00Z', now);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7200 });
    expect(sessionCookieOptions('2026-09-22T09:00:00Z', now).maxAge).toBe(0);
  });
});
