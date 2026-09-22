import { describe, expect, it } from 'vitest';
import { apiFieldErrors, changedFields, displayValue, parseWorkerForm, toPercent, type WorkerValues } from '../../../components/system/worker-form';

const current: WorkerValues = {
  minWarmWorkers: 2,
  maxWorkers: 10,
  conversationsPerWorker: 10,
  targetUtilization: 0.75,
  scaleOutQueueAgeSeconds: 10,
  scaleOutQueueDepth: 20,
  scaleInCooldownSeconds: 180,
  turnTimeoutSeconds: 90,
  leaseDurationSeconds: 45,
  heartbeatIntervalSeconds: 10,
  idleLeaseSeconds: 300,
  autoscalingEnabled: false,
};

const asText = (v: WorkerValues) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'targetUtilization' ? String(toPercent(x as number)) : String(x)]));

describe('worker configuration form', () => {
  it('shows the stored utilization fraction as a percentage without float noise', () => {
    expect(toPercent(0.699999988079071)).toBe(70);
    expect(displayValue(current, 'targetUtilization')).toBe('75');
    expect(displayValue(current, 'maxWorkers')).toBe('10');
  });

  it('parses numbers, converts the percentage back to a fraction and keeps bounds for the API', () => {
    const parsed = parseWorkerForm({ ...asText(current), maxWorkers: '12', targetUtilization: '80', minWarmWorkers: '-5' }, true);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.values.maxWorkers).toBe(12);
    expect(parsed.values.targetUtilization).toBe(0.8);
    // Out-of-range values are not judged here: the API's message is what the admin sees.
    expect(parsed.values.minWarmWorkers).toBe(-5);
    expect(parsed.values.autoscalingEnabled).toBe(true);
  });

  it('flags blanks and non-numbers per field', () => {
    const parsed = parseWorkerForm({ ...asText(current), maxWorkers: '', turnTimeoutSeconds: 'ninety' }, false);
    expect(parsed).toEqual({ ok: false, fieldErrors: { maxWorkers: 'Enter a number', turnTimeoutSeconds: 'Enter a number' } });
  });

  it('sends only the fields that changed', () => {
    expect(changedFields(current, { ...current, maxWorkers: 12 })).toEqual({ maxWorkers: 12 });
    expect(changedFields(current, { ...current, targetUtilization: 0.7500000001 })).toEqual({});
    expect(changedFields(current, { ...current, autoscalingEnabled: true })).toEqual({ autoscalingEnabled: true });
  });

  it('maps the API validation message onto fields and keeps the rest form-level', () => {
    const { fieldErrors, rest } = apiFieldErrors('maxWorkers: Too small: expected number to be >=1; minWarmWorkers: must not exceed max workers; body: odd');
    expect(fieldErrors).toEqual({ maxWorkers: 'Too small: expected number to be >=1', minWarmWorkers: 'must not exceed max workers' });
    expect(rest).toEqual(['body: odd']);
    expect(apiFieldErrors('Invalid request').rest).toEqual(['Invalid request']);
  });
});
