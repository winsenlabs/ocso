import { describe, expect, it } from 'vitest';
import {
  bucketMax,
  cacheLabel,
  dotClass,
  formatMemory,
  formatMoney,
  mcpChip,
  providerChip,
  queueAgeTone,
  utilClass,
  workerChip,
  workerLabel,
} from '../../../components/system/system-meta';

describe('system control center display rules', () => {
  it('maps service status to the design dots', () => {
    expect(dotClass('ok')).toBe('okdot');
    expect(dotClass('degraded')).toBe('okdot w');
    expect(dotClass('down')).toBe('okdot d');
    expect(dotClass('unknown')).toBe('okdot m');
  });

  it('labels workers by effective status (stale heartbeat is not healthy)', () => {
    expect(workerChip('HEALTHY')).toEqual({ tone: 'good', label: 'healthy' });
    expect(workerChip('STALE').tone).toBe('warn');
    expect(workerChip('LOST').tone).toBe('danger');
    expect(workerChip('SOMETHING_NEW')).toEqual({ tone: 'muted', label: 'something_new' });
    expect(workerLabel({ id: '0191-abcd-7f21a', hostname: 'wkr-7f21a' })).toBe('wkr-7f21a');
    expect(workerLabel({ id: '01919a3c-1111-7222-8333-94445557f21a', hostname: 'ip-10-0-12-34.ap-south-1.compute.internal' })).toBe('wkr-7f21a');
  });

  it('tones utilisation bars only when slots run hot', () => {
    expect(utilClass(null)).toBeUndefined();
    expect(utilClass(0.6)).toBeUndefined();
    expect(utilClass(0.9)).toBe('w');
    expect(utilClass(1)).toBe('d');
  });

  it('derives provider chips from status and last-hour errors, never inventing health', () => {
    expect(providerChip({ enabled: false, status: 'OK', profiles: [1], errorRate: 0 })).toEqual({ tone: 'muted', label: 'disabled' });
    expect(providerChip({ enabled: true, status: 'DOWN', profiles: [1], errorRate: null })).toMatchObject({ label: 'down', card: 'danger' });
    expect(providerChip({ enabled: true, status: 'OK', profiles: [1], errorRate: 0.08 })).toMatchObject({ label: 'elevated', card: 'warn' });
    expect(providerChip({ enabled: true, status: 'OK', profiles: [], errorRate: null })).toEqual({ tone: 'muted', label: 'standby' });
    expect(providerChip({ enabled: true, status: 'UNTESTED', profiles: [1], errorRate: null }).label).toBe('untested');
    expect(providerChip({ enabled: true, status: 'OK', profiles: [1], errorRate: 0.001 })).toEqual({ tone: 'good', label: 'ok' });
    expect(mcpChip('ACTIVE').label).toBe('healthy');
    expect(mcpChip('AUTH_REQUIRED').tone).toBe('warn');
  });

  it('reports cache reads as observed: no traffic, not reported, or the share', () => {
    expect(cacheLabel(null, 'NO_TRAFFIC')).toBe('—');
    expect(cacheLabel(null, 'NOT_REPORTED')).toBe('not reported');
    expect(cacheLabel(0.9137, 'REPORTED')).toBe('91.4%');
  });

  it('formats cost, memory and queue age warnings', () => {
    expect(formatMoney(null, 'USD')).toBe('—');
    expect(formatMoney(12_345_000, 'USD')).toBe('$12.35');
    expect(formatMoney(18_400_000_000, 'INR')).toBe('₹18,400');
    expect(formatMoney(5_000_000, 'MIXED')).toBe('5.00 (mixed currencies)');
    expect(formatMemory(1843)).toBe('1.8 GB');
    expect(formatMemory(512)).toBe('512 MB');
    expect(queueAgeTone(18, 10)).toBe('warn');
    expect(queueAgeTone(null, 10)).toBeUndefined();
  });

  it('downsamples a series by bucket maximum so spikes survive', () => {
    expect(bucketMax([1, 5, 2, null, null, 3], 3)).toEqual([5, 2, 3]);
    expect(bucketMax([null, null, 4, 1], 2)).toEqual([null, 4]);
    expect(bucketMax([1, 2], 10)).toEqual([1, 2]);
  });
});
