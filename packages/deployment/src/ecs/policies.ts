import type {
  StepScalingPolicyConfiguration,
  TargetTrackingMetricDataQuery,
  TargetTrackingScalingPolicyConfiguration,
} from '@aws-sdk/client-application-auto-scaling';
import type { MetricAlarm, PutMetricAlarmInput } from '@aws-sdk/client-cloudwatch';
import { targetSlotDemandPerWorker } from '../capacity.js';
import type { ScalingSettings } from '../contract.js';
import { METRIC, METRIC_DIMENSION_NAME } from './names.js';

/** Scale out fast (custom metrics are 1-minute resolution anyway); scale in per settings. */
export const SCALE_OUT_COOLDOWN_SECONDS = 60;
/** Step bounds are relative to the alarm threshold: [T, T+60 s) → +1, ≥ T+60 s → +3. */
export const QUEUE_AGE_STEP_WIDTH_SECONDS = 60;
/** Research/05 §2: validate against real data with GetMetricData before release (ADR-023). */
export const SLOT_DEMAND_PER_WORKER_EXPRESSION = 'IF(workers > 0, demand / workers, demand)';

export interface MetricTarget {
  namespace: string;
  dimensionValue: string;
}

function metricQuery(id: string, metricName: string, label: string, m: MetricTarget): TargetTrackingMetricDataQuery {
  return {
    Id: id,
    Label: label,
    ReturnData: false,
    // Average, not Sum: two leaders overlapping for a moment must not double demand.
    MetricStat: {
      Stat: 'Average',
      Metric: { Namespace: m.namespace, MetricName: metricName, Dimensions: [{ Name: METRIC_DIMENSION_NAME, Value: m.dimensionValue }] },
    },
  };
}

/** Target tracking on metric math "slot demand per worker" (ADR-023). */
export function targetTrackingConfiguration(s: ScalingSettings, m: MetricTarget): TargetTrackingScalingPolicyConfiguration {
  return {
    TargetValue: targetSlotDemandPerWorker(s),
    ScaleOutCooldown: SCALE_OUT_COOLDOWN_SECONDS,
    ScaleInCooldown: s.scaleInCooldownSeconds,
    CustomizedMetricSpecification: {
      Metrics: [
        metricQuery('demand', METRIC.SLOT_DEMAND, 'Active plus queued conversations', m),
        metricQuery('workers', METRIC.WORKERS, 'Workers with a fresh heartbeat', m),
        { Id: 'perworker', Label: 'Slot demand per worker', Expression: SLOT_DEMAND_PER_WORKER_EXPRESSION, ReturnData: true },
      ],
    },
  };
}

/** Step scaling for bursts and scale-from-floor, driven by the queue-age alarm. */
export function stepScalingConfiguration(): StepScalingPolicyConfiguration {
  return {
    AdjustmentType: 'ChangeInCapacity',
    Cooldown: SCALE_OUT_COOLDOWN_SECONDS,
    MetricAggregationType: 'Maximum',
    StepAdjustments: [
      { MetricIntervalLowerBound: 0, MetricIntervalUpperBound: QUEUE_AGE_STEP_WIDTH_SECONDS, ScalingAdjustment: 1 },
      { MetricIntervalLowerBound: QUEUE_AGE_STEP_WIDTH_SECONDS, ScalingAdjustment: 3 },
    ],
  };
}

/** Alarm attributes carried over verbatim when OCSO updates an existing alarm. */
const ALARM_CONFIG_KEYS = [
  'AlarmDescription',
  'ActionsEnabled',
  'OKActions',
  'AlarmActions',
  'InsufficientDataActions',
  'MetricName',
  'Namespace',
  'Statistic',
  'ExtendedStatistic',
  'Dimensions',
  'Period',
  'Unit',
  'EvaluationPeriods',
  'DatapointsToAlarm',
  'Threshold',
  'ComparisonOperator',
  'TreatMissingData',
  'EvaluateLowSampleCountPercentile',
  'Metrics',
  'ThresholdMetricId',
] as const satisfies ReadonlyArray<keyof MetricAlarm & keyof PutMetricAlarmInput>;

export interface AlarmPlan {
  input: PutMetricAlarmInput;
  changed: boolean;
  warnings: string[];
}

/**
 * The queue-age alarm. When it exists (Terraform creates it on the SQS
 * `ApproximateAgeOfOldestMessage` of the turn queue and ignores only the
 * threshold), OCSO keeps its metric and changes just the threshold — and adds
 * the step policy to its actions if missing — so `terraform apply` never
 * fights the runtime value. Otherwise OCSO creates it on its own
 * `OldestQueueAgeSeconds` metric, which works with any queue driver.
 */
export function queueAgeAlarmPlan(args: {
  name: string;
  thresholdSeconds: number;
  policyArn: string;
  existing: MetricAlarm | undefined;
  metrics: MetricTarget;
}): AlarmPlan {
  const { name, thresholdSeconds, policyArn, existing } = args;
  if (existing) {
    const input: PutMetricAlarmInput = { AlarmName: name };
    for (const key of ALARM_CONFIG_KEYS) {
      if (existing[key] !== undefined) Object.assign(input, { [key]: existing[key] });
    }
    const actions = existing.AlarmActions ?? [];
    input.Threshold = thresholdSeconds;
    input.AlarmActions = actions.includes(policyArn) ? actions : [...actions, policyArn];
    const warnings = existing.ActionsEnabled === false ? [`Alarm ${name} has its actions disabled (set outside OCSO), so queue-age step scaling cannot fire.`] : [];
    return { input, changed: existing.Threshold !== thresholdSeconds || !actions.includes(policyArn), warnings };
  }
  return {
    changed: true,
    warnings: [],
    input: {
      AlarmName: name,
      AlarmDescription: 'Oldest waiting conversation turn is older than the Tech admin queue-age threshold: step-scale workers out. Managed by the OCSO worker deployment adapter (ADR-023).',
      Namespace: args.metrics.namespace,
      MetricName: METRIC.OLDEST_QUEUE_AGE,
      Dimensions: [{ Name: METRIC_DIMENSION_NAME, Value: args.metrics.dimensionValue }],
      Statistic: 'Maximum',
      Period: 60,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      Threshold: thresholdSeconds,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      ActionsEnabled: true,
      AlarmActions: [policyArn],
    },
  };
}
