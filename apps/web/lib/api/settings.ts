import 'server-only';
import { z } from 'zod';
import { api } from './client';

/** GET /v1/settings/deployment (deployment_settings singleton). */
export const DeploymentSettingsSchema = z.object({
  orgName: z.string(),
  deploymentLabel: z.string(),
  regionLabel: z.string().nullable(),
  timezone: z.string(),
  residencyZone: z.string().nullable(),
  allowCrossProviderFallback: z.boolean(),
  allowCrossRegionFallback: z.boolean(),
  execsCanViewAiActive: z.boolean(),
  setupCompletedAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});
export type DeploymentSettings = z.infer<typeof DeploymentSettingsSchema>;

export interface DeploymentSettingsPatch {
  orgName?: string;
  deploymentLabel?: string;
  regionLabel?: string | null;
  timezone?: string;
  residencyZone?: string | null;
  allowCrossProviderFallback?: boolean;
  allowCrossRegionFallback?: boolean;
  execsCanViewAiActive?: boolean;
}

/** GET /v1/settings/workers (worker_settings singleton, docs/10 §5). */
export const WorkerSettingsSchema = z.object({
  minWarmWorkers: z.number(),
  maxWorkers: z.number(),
  conversationsPerWorker: z.number(),
  targetUtilization: z.number(),
  scaleOutQueueAgeSeconds: z.number(),
  scaleOutQueueDepth: z.number(),
  scaleInCooldownSeconds: z.number(),
  turnTimeoutSeconds: z.number(),
  leaseDurationSeconds: z.number(),
  heartbeatIntervalSeconds: z.number(),
  idleLeaseSeconds: z.number(),
  autoscalingEnabled: z.boolean(),
  updatedAt: z.string().nullable().optional(),
});
export type WorkerSettings = z.infer<typeof WorkerSettingsSchema>;

export function getDeploymentSettings(): Promise<DeploymentSettings> {
  return api.get('/v1/settings/deployment', DeploymentSettingsSchema);
}

export function updateDeploymentSettings(patch: DeploymentSettingsPatch): Promise<DeploymentSettings> {
  return api.patch('/v1/settings/deployment', patch, DeploymentSettingsSchema);
}

export function getWorkerSettings(): Promise<WorkerSettings> {
  return api.get('/v1/settings/workers', WorkerSettingsSchema);
}
