import 'server-only';
import { z } from 'zod';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/**
 * Worker scaling settings and how far the deployment has applied them
 * (GET/PATCH /v1/settings/workers, GET /v1/settings/workers/deployment;
 * docs/archive/specs/10 §5, ADR-023). Scaling is driven by conversation demand and queue
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

/** The editable fields, in form order (docs/archive/specs/10 §5). */
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

/** One panel row in the deployment driver's own words (DeploymentFact); the UI never needs to know the driver. */
const DeploymentFact = z.object({
  label: z.string(),
  value: z.string(),
  states: z.array(z.object({ name: z.string(), tone: z.string(), title: z.string().optional() })).optional(),
});
/** Any driver's describe() snapshot; snapshots recorded before `facts` existed may carry only a `note`. */
const DeploymentStatus = z.object({
  driver: z.string(),
  checkedAt: z.string().optional(),
  facts: z.array(DeploymentFact).optional(),
  note: z.string().optional(),
});

export const WorkerDeploymentSchema = z.object({
  driver: z.string().nullable(),
  deployment: DeploymentStatus.nullable(),
  describedAt: z.string().nullable(),
  describeError: z.string().nullable(),
});
export type WorkerDeployment = z.infer<typeof WorkerDeploymentSchema>;
export type DeploymentFactView = z.infer<typeof DeploymentFact>;

export const loadWorkerSettings = () => api.get('/v1/settings/workers', WorkerSettingsSchema);
/** Worker settings are deployment settings: a change is a proposal (202) naming its checker (PM/research/11 §4). */
export const updateWorkerSettings = (patch: WorkerSettingsPatch & { approval: { checkerId: string; reason: string } | { bootstrap: true; reason: string } }) => api.patch('/v1/settings/workers', patch, z.union([ProposedSchema, WorkerSettingsSchema]));
export const loadWorkerDeployment = () => api.get('/v1/settings/workers/deployment', WorkerDeploymentSchema);
