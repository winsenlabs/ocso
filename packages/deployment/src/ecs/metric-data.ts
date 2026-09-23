import type { MetricDatum } from '@aws-sdk/client-cloudwatch';
import type { ScalingSample } from '../contract.js';
import { METRIC, METRIC_DIMENSION_NAME } from './names.js';

/**
 * PutMetricData payload for one sample (ADR-023). Zeros are published, not
 * skipped: target tracking treats missing data as INSUFFICIENT_DATA and stops
 * scaling. Latency is omitted without data because a zero would be a lie.
 */
export function metricData(sample: ScalingSample, dimensionValue: string): MetricDatum[] {
  const base = { Dimensions: [{ Name: METRIC_DIMENSION_NAME, Value: dimensionValue }], Timestamp: sample.at, StorageResolution: 60 };
  const data: MetricDatum[] = [
    { ...base, MetricName: METRIC.SLOT_DEMAND, Value: nonNegative(sample.slotDemand), Unit: 'Count' },
    { ...base, MetricName: METRIC.WORKERS, Value: nonNegative(sample.workers), Unit: 'Count' },
    { ...base, MetricName: METRIC.OLDEST_QUEUE_AGE, Value: nonNegative(sample.oldestQueueAgeSeconds), Unit: 'Seconds' },
    { ...base, MetricName: METRIC.TURNS_IN_FLIGHT, Value: nonNegative(sample.turnsInFlight), Unit: 'Count' },
  ];
  if (sample.turnLatencyP95Ms !== null && Number.isFinite(sample.turnLatencyP95Ms)) {
    data.push({ ...base, MetricName: METRIC.TURN_LATENCY_P95, Value: nonNegative(sample.turnLatencyP95Ms), Unit: 'Milliseconds' });
  }
  return data;
}

function nonNegative(v: number): number {
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}
