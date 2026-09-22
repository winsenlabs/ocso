import { describe, expect, it } from 'vitest';
import { percentilePair, percentileRows, purposeLabel, windowLabel } from '../../../components/system/telemetry-meta';

describe('telemetry percentiles and purposes', () => {
  it('shows p50 beside p95 and never invents a value', () => {
    expect(percentilePair(2500, 3850)).toBe('2.5s · 3.9s');
    expect(percentilePair(550, 955)).toBe('550ms · 955ms');
    expect(percentilePair(null, 955)).toBe('— · 955ms');
    expect(percentilePair(null, null)).toBeNull();
  });

  it('turns the window percentiles into table rows with sample counts', () => {
    const rows = percentileRows({ turns: 4, turnP50Ms: 2500, turnP95Ms: 3850, ttftRequests: 10, ttftP50Ms: 550, ttftP95Ms: 955 });
    expect(rows.map((r) => [r.key, r.p50, r.p95, r.samples])).toEqual([
      ['turn', 2500, 3850, 4],
      ['ttft', 550, 955, 10],
    ]);
    const empty = percentileRows({ turns: 0, turnP50Ms: null, turnP95Ms: null, ttftRequests: 0, ttftP50Ms: null, ttftP95Ms: null });
    expect(empty.every((r) => r.p50 === null && r.p95 === null && r.samples === 0)).toBe(true);
  });

  it('labels every usage_events purpose and degrades gracefully for new ones', () => {
    for (const p of ['TURN', 'SUMMARY', 'COPILOT', 'INTERNAL_AGENT', 'CLASSIFIER', 'EVALUATION', 'TEST']) {
      expect(purposeLabel(p).label).not.toBe(p.toLowerCase());
    }
    expect(purposeLabel('TURN')).toEqual({ label: 'Customer turns', hint: 'agent replies to customers' });
    expect(purposeLabel('NEW_KIND')).toEqual({ label: 'new kind', hint: 'other requests' });
  });

  it('labels latency windows', () => {
    expect(windowLabel(60)).toBe('1h');
    expect(windowLabel(360)).toBe('6h');
    expect(windowLabel(5)).toBe('5m');
  });
});
