import type { StepScalingPolicyConfiguration, TargetTrackingScalingPolicyConfiguration } from '@aws-sdk/client-application-auto-scaling';

/**
 * Semantic fingerprints of scaling policy configurations. Reconcile re-puts a
 * policy only when its fingerprint differs: re-putting a target-tracking
 * policy recreates its alarms, which would reset their evaluation every
 * reconcile. Labels and absent-vs-default fields are ignored on purpose.
 */
export function targetTrackingFingerprint(c: TargetTrackingScalingPolicyConfiguration | undefined): string {
  if (!c) return 'none';
  const spec = c.CustomizedMetricSpecification;
  return JSON.stringify({
    target: c.TargetValue ?? null,
    out: c.ScaleOutCooldown ?? null,
    in: c.ScaleInCooldown ?? null,
    disableIn: c.DisableScaleIn ?? false,
    predefined: c.PredefinedMetricSpecification?.PredefinedMetricType ?? null,
    metrics: (spec?.Metrics ?? []).map((q) => ({
      id: q.Id ?? null,
      expr: q.Expression ?? null,
      ret: q.ReturnData ?? true,
      stat: q.MetricStat?.Stat ?? null,
      ns: q.MetricStat?.Metric?.Namespace ?? null,
      name: q.MetricStat?.Metric?.MetricName ?? null,
      dims: (q.MetricStat?.Metric?.Dimensions ?? []).map((d) => `${d.Name}=${d.Value}`).sort(),
    })),
    single: spec?.MetricName ? { ns: spec.Namespace ?? null, name: spec.MetricName, stat: spec.Statistic ?? null } : null,
  });
}

export function stepScalingFingerprint(c: StepScalingPolicyConfiguration | undefined): string {
  if (!c) return 'none';
  return JSON.stringify({
    type: c.AdjustmentType ?? null,
    cooldown: c.Cooldown ?? null,
    aggregation: c.MetricAggregationType ?? 'Average',
    minMagnitude: c.MinAdjustmentMagnitude ?? null,
    steps: (c.StepAdjustments ?? [])
      .map((s) => [s.MetricIntervalLowerBound ?? null, s.MetricIntervalUpperBound ?? null, s.ScalingAdjustment ?? null])
      .sort((a, b) => (a[0] ?? -Infinity) - (b[0] ?? -Infinity)),
  });
}
