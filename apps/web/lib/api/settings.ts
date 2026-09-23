import 'server-only';
import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposedSchema } from '@/components/approvals/lib/schemas';
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

/** Settings are always live: the change is a proposal (202) — `approval` names the checker (PM/research/11 §4). */
export function updateDeploymentSettings(patch: DeploymentSettingsPatch & { approval: { checkerId: string; reason: string } | { bootstrap: true; reason: string } }): Promise<unknown> {
  return api.patch('/v1/settings/deployment', patch, z.union([ProposedSchema, DeploymentSettingsSchema]));
}

/** The open (or activating) settings proposal, for the Settings screens' pending badge; null when none or not permitted. */
export function getSettingsApproval() {
  return api.get('/v1/settings/approval', ObjectApprovalStateSchema).catch(() => null);
}

export function getWorkerSettings(): Promise<WorkerSettings> {
  return api.get('/v1/settings/workers', WorkerSettingsSchema);
}
