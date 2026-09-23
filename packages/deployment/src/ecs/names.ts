/**
 * Names shared with the Terraform contract (infra/aws/terraform,
 * modules/autoscaling and modules/iam/scaling.tf; docs/operations/aws.md §7).
 * Terraform creates these resources and ignores the attributes OCSO owns at
 * runtime; the adapter only ever addresses them by these exact names and
 * never lists, creates under other names, or deletes anything else.
 */

export const SCALABLE_DIMENSION = 'ecs:service:DesiredCount' as const;
export const SERVICE_NAMESPACE = 'ecs' as const;

/** Custom metrics published by the worker leader every 60 s (ADR-023). */
export const METRIC = {
  SLOT_DEMAND: 'SlotDemand',
  WORKERS: 'Workers',
  OLDEST_QUEUE_AGE: 'OldestQueueAgeSeconds',
  TURNS_IN_FLIGHT: 'TurnsInFlight',
  TURN_LATENCY_P95: 'TurnLatencyP95',
} as const;

/** The only metric dimension (low cardinality): `Service=worker`. */
export const METRIC_DIMENSION_NAME = 'Service';
export const DEFAULT_METRIC_DIMENSION_VALUE = 'worker';

export interface EcsScalingNames {
  cluster: string;
  service: string;
  /** Application Auto Scaling resource id: `service/<cluster>/<service>`. */
  resourceId: string;
  targetTrackingPolicy: string;
  stepPolicy: string;
  queueAgeAlarm: string;
  /** IAM scopes PutMetricAlarm/DeleteAlarms to alarms with this prefix. */
  alarmPrefix: string;
}

/** Accepts names or ARNs (`arn:aws:ecs:…:cluster/<name>`, `…:service/<cluster>/<name>`). */
export function shortName(nameOrArn: string): string {
  const trimmed = nameOrArn.trim();
  return trimmed.startsWith('arn:') ? (trimmed.split('/').pop() ?? trimmed) : trimmed;
}

/** Deployment-specific names: the cluster name equals Terraform's `<name>-<env>` prefix. */
export function ecsScalingNames(clusterNameOrArn: string, serviceNameOrArn: string): EcsScalingNames {
  const cluster = shortName(clusterNameOrArn);
  const service = shortName(serviceNameOrArn);
  const alarmPrefix = `${cluster}-worker-`;
  return {
    cluster,
    service,
    resourceId: `service/${cluster}/${service}`,
    targetTrackingPolicy: `${alarmPrefix}slot-demand`,
    stepPolicy: `${alarmPrefix}queue-age`,
    queueAgeAlarm: `${alarmPrefix}queue-age-high`,
    alarmPrefix,
  };
}

/** Terraform's default namespace for a cluster named `<name>-<env>`. */
export function defaultMetricsNamespace(clusterNameOrArn: string): string {
  return `OCSO/${shortName(clusterNameOrArn)}`;
}
