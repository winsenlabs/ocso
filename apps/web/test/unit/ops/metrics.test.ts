import { describe, expect, it } from 'vitest';
import {
  countDelta,
  dayKey,
  durationDelta,
  formatMoneyMicros,
  humanizeCode,
  numberNotes,
  parseDays,
  rateDelta,
  reasonLabels,
  reasonSeries,
  scoreDelta,
  share,
  shortDay,
  windowLabel,
} from '../../../components/analytics/metrics';
import { hrefWith, idParam, param } from '../../../components/analytics/params';

describe('analytics window', () => {
  it('accepts only the offered windows and defaults to 7 days', () => {
    expect(parseDays('30')).toBe(30);
    expect(parseDays('1')).toBe(1);
    expect(parseDays('14')).toBe(7);
    expect(parseDays('abc')).toBe(7);
    expect(parseDays(undefined)).toBe(7);
    expect(windowLabel(90)).toBe('last 90 days');
  });
});

describe('deltas vs the previous window', () => {
  it('moves rates in percentage points', () => {
    expect(rateDelta(0.186, 0.168)).toBe('+1.8pt');
    expect(rateDelta(0.5, 0.52)).toBe('−2.0pt');
    expect(rateDelta(0.5, 0.5)).toBe('±0pt');
    expect(rateDelta(null, 0.5)).toBeNull();
    expect(rateDelta(0.5, null)).toBeNull();
  });

  it('moves counts relatively, and never against an empty previous window', () => {
    expect(countDelta(4812, 4531)).toBe('+6.2%');
    expect(countDelta(5, 10)).toBe('−50.0%');
    expect(countDelta(3, 0)).toBeNull();
  });

  it('moves durations and CSAT in their own units', () => {
    expect(durationDelta(75, 15)).toBe('+1m');
    expect(durationDelta(10, 14)).toBe('−4s');
    expect(durationDelta(null, 3)).toBeNull();
    expect(scoreDelta(4.41, 4.2)).toBe('+0.21');
    expect(scoreDelta(4, 4)).toBe('±0.00');
  });
});

describe('formatting', () => {
  it('prices micros in the reported currency and says so when mixed', () => {
    expect(formatMoneyMicros(4_800_000, 'USD')).toBe('$4.80');
    expect(formatMoneyMicros(12_345, 'USD')).toBe('$0.0123');
    expect(formatMoneyMicros(null, 'USD')).toBe('—');
    expect(formatMoneyMicros(1_500_000, 'MIXED')).toContain('mixed currencies');
  });

  it('humanizes reason and trigger codes', () => {
    expect(humanizeCode('customer_request')).toBe('Customer request');
    expect(humanizeCode('TOOL_FAILURE')).toBe('Tool failure');
    expect(humanizeCode('ai_unavailable')).toBe('Ai unavailable');
  });

  it('adds the trigger only where two reason groups would read the same', () => {
    expect(
      reasonLabels([
        { reasonCode: 'refund_limit', trigger: 'BUSINESS_RULE' },
        { reasonCode: 'refund_limit', trigger: 'AGENT_DECISION' },
        { reasonCode: 'customer_request', trigger: 'CUSTOMER_REQUEST' },
      ]),
    ).toEqual(['Refund limit · Business rule', 'Refund limit · Agent decision', 'Customer request']);
  });

  it('places instants on the deployment calendar day', () => {
    expect(dayKey('2026-09-21T20:00:00Z', 'Asia/Kolkata')).toBe('2026-09-22');
    expect(dayKey('2026-09-21T20:00:00Z', 'UTC')).toBe('2026-09-21');
    expect(dayKey('nope', 'UTC')).toBeNull();
    expect(shortDay('2026-09-14')).toBe('14 Sep');
  });

  it('clamps bar shares', () => {
    expect(share(3, 4)).toBe(0.75);
    expect(share(3, 0)).toBe(0);
    expect(share(5, 4)).toBe(1);
  });
});

describe('metric definitions as footnotes', () => {
  it('numbers distinct definitions in first-seen order and shares numbers for identical formulas', () => {
    const notes = numberNotes([
      ['containmentRate', 'A'],
      ['escalationRate', 'B'],
      ['agents.containmentRate', 'A'],
      ['queues.avgWaitSeconds', 'C'],
    ]);
    expect(notes.refs).toEqual({ containmentRate: 1, escalationRate: 2, 'agents.containmentRate': 1, 'queues.avgWaitSeconds': 3 });
    expect(notes.list).toEqual([
      { n: 1, text: 'A' },
      { n: 2, text: 'B' },
      { n: 3, text: 'C' },
    ]);
  });
});

describe('escalation reasons per day', () => {
  const daily = [
    { day: '2026-09-20', total: 4, byReason: { a: 2, b: 1, c: 1 } },
    { day: '2026-09-21', total: 0, byReason: {} },
    { day: '2026-09-22', total: 3, byReason: { a: 1, c: 2 } },
  ];

  it('keeps the top codes and folds the rest into "other"', () => {
    expect(reasonSeries(daily, ['a', 'c', 'b'], 2)).toEqual([
      { reasonCode: 'a', values: [2, 0, 1] },
      { reasonCode: 'c', values: [1, 0, 2] },
      { reasonCode: 'other', values: [1, 0, 0] },
    ]);
  });

  it('omits "other" when the top codes cover everything and ignores duplicate codes', () => {
    expect(reasonSeries(daily, ['a', 'a', 'b', 'c'], 4).map((s) => s.reasonCode)).toEqual(['a', 'b', 'c']);
  });
});

describe('search params', () => {
  it('reads first values, validates ids and builds hrefs without empty values', () => {
    expect(param({ q: ['x', 'y'] }, 'q')).toBe('x');
    expect(param({ q: '' }, 'q')).toBeUndefined();
    expect(idParam({ id: 'not-an-id' }, 'id')).toBeUndefined();
    expect(idParam({ id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' }, 'id')).toBe('0192f3a4-5b6c-7d8e-9f01-23456789abcd');
    expect(hrefWith('/customers', { q: 'priya', customer: undefined, days: 7 })).toBe('/customers?q=priya&days=7');
    expect(hrefWith('/customers', { q: '' })).toBe('/customers');
  });
});
