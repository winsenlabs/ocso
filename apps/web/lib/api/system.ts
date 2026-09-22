import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * Worker scaling settings and how far the deployment has applied them
 * (GET/PATCH /v1/settings/workers, GET /v1/settings/workers/deployment;
 * docs/10 §5, ADR-023). Scaling is driven by conversation demand and queue
 * age — never CPU alone.
 */

const n = z.number();
const nn = z.number().nullable();
const strings = z.array(z.string()).default([]);

const EffectiveScaling = z.object({
  autoscaling: z.boolean(),
  minCapacity: n,
  maxCapacity: n,
  targetSlotDemandPerWorker: nn,
  queueAgeThresholdSeconds: nn,
  scaleInCooldownSeconds: nn,
  scaleOutCooldownSeconds: nn,
});
export type EffectiveScaling = z.infer<typeof EffectiveScaling>;

export const SCALING_STATUSES = ['PENDING', 'APPLIED', 'ADVISORY', 'FAILED'] as const;
export type ScalingApplyStatus = (typeof SCALING_STATUSES)[number];

export const ScalingStatusSchema = z.object({
  status: z.enum(SCALING_STATUSES),
  lastOutcome: z.enum(['APPLIED', 'ADVISORY', 'FAILED']).nullable(),
  driver: z.string().nullable(),
  message: z.string(),
  advisory: z.string().nullable(),
  commands: strings,
  changes: strings,
  warnings: strings,
  effective: EffectiveScaling.nullable(),
  attemptedAt: z.string().nullable(),
  lastSucceededAt: z.string().nullable(),
  appliedSettingsAt: z.string().nullable(),
  inSync: z.boolean(),
});
export type ScalingStatus = z.infer<typeof ScalingStatusSchema>;

/** The editable fields, in form order (docs/10 §5). */
export const WORKER_FIELDS = [
  'minWarmWorkers',
  'maxWorkers',
  'conversationsPerWorker',
  'targetUtilization',
  'scaleOutQueueAgeSeconds',
  'scaleOutQueueDepth',
  'scaleInCooldownSeconds',
  'turnTimeoutSeconds',
  'leaseDurationSeconds',
  'heartbeatIntervalSeconds',
  'idleLeaseSeconds',
] as const;
export type WorkerField = (typeof WORKER_FIELDS)[number];

export const WorkerSettingsSchema = z.object({
  minWarmWorkers: n,
  maxWorkers: n,
  conversationsPerWorker: n,
  targetUtilization: n,
  scaleOutQueueAgeSeconds: n,
  scaleOutQueueDepth: n,
  scaleInCooldownSeconds: n,
  turnTimeoutSeconds: n,
  leaseDurationSeconds: n,
  heartbeatIntervalSeconds: n,
  idleLeaseSeconds: n,
  autoscalingEnabled: z.boolean(),
  updatedAt: z.string().nullable().optional(),
  /** Present once the deployment adapter reports (ADR-023); absent on older APIs. */
  scaling: ScalingStatusSchema.optional(),
});
export type WorkerSettingsView = z.infer<typeof WorkerSettingsSchema>;
export type WorkerSettingsPatch = Partial<Record<WorkerField, number>> & { autoscalingEnabled?: boolean };

const EcsStatus = z.object({
  driver: z.literal('ecs'),
  checkedAt: z.string(),
  cluster: z.string(),
  service: z.string(),
  serviceStatus: z.string(),
  desiredCount: nn,
  runningCount: nn,
  pendingCount: nn,
  rolloutState: z.string().nullable(),
  scalableTarget: z.object({ minCapacity: n, maxCapacity: n, dynamicScalingSuspended: z.boolean() }).nullable(),
  policies: z.array(z.object({ name: z.string(), type: z.string(), present: z.boolean() })),
  alarms: z.array(z.object({ name: z.string(), state: z.string() })),
});
const ComposeStatus = z.object({ driver: z.literal('compose'), checkedAt: z.string(), replicaControl: z.string(), note: z.string() });

export const WorkerDeploymentSchema = z.object({
  driver: z.string().nullable(),
  /** A driver this UI does not know yet still parses (rendered generically). */
  deployment: z.union([EcsStatus, ComposeStatus, z.object({ driver: z.string(), checkedAt: z.string().optional() })]).nullable(),
  describedAt: z.string().nullable(),
  describeError: z.string().nullable(),
});
export type WorkerDeployment = z.infer<typeof WorkerDeploymentSchema>;
export type EcsDeploymentStatus = z.infer<typeof EcsStatus>;

export const loadWorkerSettings = () => api.get('/v1/settings/workers', WorkerSettingsSchema);
export const updateWorkerSettings = (patch: WorkerSettingsPatch) => api.patch('/v1/settings/workers', patch, WorkerSettingsSchema);
export const loadWorkerDeployment = () => api.get('/v1/settings/workers/deployment', WorkerDeploymentSchema);
