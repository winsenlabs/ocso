import { eq } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { validation } from '@ocso/domain';
import { approvalRequiredError } from '../approvals/guard.js';
import { deploymentSettings, workerSettings, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext, Db } from '../shared/context.js';
import { RetentionInput } from '../retention/policy.js';

export type DeploymentSettings = typeof deploymentSettings.$inferSelect;
export type WorkerSettings = typeof workerSettings.$inferSelect;

export const DeploymentSettingsInput = z.object({
  orgName: z.string().trim().min(1).max(200).optional(),
  deploymentLabel: z.string().trim().min(1).max(40).optional(),
  regionLabel: z.string().trim().max(60).nullable().optional(),
  timezone: z.string().max(64).optional(),
  residencyZone: z.string().trim().max(20).nullable().optional(),
  providerAllowlist: z.array(z.uuid()).optional(),
  allowCrossProviderFallback: z.boolean().optional(),
  allowCrossRegionFallback: z.boolean().optional(),
  maxOutputCostPerMTokMicros: z.number().int().positive().nullable().optional(),
  execsCanViewAiActive: z.boolean().optional(),
  retention: RetentionInput.optional(),
  egressAllowedInternalHosts: z.array(z.string().max(253)).max(200).optional(),
  internalAgentProfileId: z.uuid().nullable().optional(),
  internalAgentConfirmLowWrites: z.boolean().optional(),
  /** Ask OCSO may propose and confirm writes (PM/research/12 §9 kill switch); off → reads only. Governed like every setting. */
  askOcsoWrites: z.boolean().optional(),
  /** Days the main database keeps audit events the audit store verified (ADR-032); the database refuses < 90. */
  auditLocalWindowDays: z.number().int().min(90).max(3650).optional(),
  /** Open approvals older than this carry the `aged` warning (PM/research/11b). */
  approvalAgeWarningHours: z.number().int().min(1).max(24 * 90).optional(),
});
export type DeploymentSettingsInput = z.infer<typeof DeploymentSettingsInput>;

/** Worker configuration with safe bounds (docs/10 §5). DB constraints mirror these. */
export const WorkerSettingsInput = z
  .object({
    minWarmWorkers: z.number().int().min(0).max(500),
    maxWorkers: z.number().int().min(1).max(500),
    conversationsPerWorker: z.number().int().min(1).max(500),
    targetUtilization: z.number().gt(0).max(1),
    scaleOutQueueAgeSeconds: z.number().int().min(1).max(3600),
    scaleOutQueueDepth: z.number().int().min(1).max(100_000),
    scaleInCooldownSeconds: z.number().int().min(30).max(86_400),
    turnTimeoutSeconds: z.number().int().min(10).max(900),
    leaseDurationSeconds: z.number().int().min(10).max(600),
    heartbeatIntervalSeconds: z.number().int().min(2).max(120),
    idleLeaseSeconds: z.number().int().min(10).max(86_400),
    autoscalingEnabled: z.boolean(),
  })
  .partial()
  .superRefine((v, ctx) => {
    if (v.minWarmWorkers !== undefined && v.maxWorkers !== undefined && v.minWarmWorkers > v.maxWorkers) {
      ctx.addIssue({ code: 'custom', path: ['minWarmWorkers'], message: 'must not exceed max workers' });
    }
    if (v.leaseDurationSeconds !== undefined && v.heartbeatIntervalSeconds !== undefined && v.leaseDurationSeconds <= v.heartbeatIntervalSeconds * 2) {
      ctx.addIssue({ code: 'custom', path: ['leaseDurationSeconds'], message: 'must exceed twice the heartbeat interval' });
    }
  });
export type WorkerSettingsInput = z.infer<typeof WorkerSettingsInput>;

/**
 * Deployment and worker settings. Every change is a proposal on the
 * deployment-settings singleton (PM/research/11 §4, settings-approval.ts):
 * the API submits it and approval applies it with the functions below, which
 * write the same audit rows the direct path used to.
 */
export class SettingsService {
  constructor(private readonly db: Db) {}

  async deployment(db: DbOrTx = this.db): Promise<DeploymentSettings> {
    const [row] = await db.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1));
    return row!;
  }

  async workers(db: DbOrTx = this.db): Promise<WorkerSettings> {
    const [row] = await db.select().from(workerSettings).where(eq(workerSettings.id, 1));
    return row!;
  }

  /** Settings are always live: a change is a proposal (409 approval_required here; the API submits it). */
  async updateDeployment(actor: ActorContext, _input: DeploymentSettingsInput): Promise<never> {
    assertCan(actor.principal!, Permission.DEPLOYMENT_SETTINGS_MANAGE);
    throw approvalRequiredError('deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE');
  }

  /** As updateDeployment (the internal agent's worker tool surfaces the 409). */
  async updateWorkers(actor: ActorContext, _input: WorkerSettingsInput): Promise<never> {
    assertCan(actor.principal!, Permission.SYSTEM_CONFIGURE);
    throw approvalRequiredError('deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE');
  }
}

/**
 * The object id of the deployment-settings singleton in approvals (PM/research/11b: the table's key is the
 * smallint 1, so a constant uuid stands for it). 11b's all-zero `…-0000-0000-…0001` is not a valid RFC 4122
 * uuid, which every approval route validates (zod `z.uuid()`), so the version/variant nibbles are set.
 */
export const SETTINGS_OBJECT_ID = '00000000-0000-4000-8000-000000000001';

/** Apply a deployment-settings patch (activation of an approved proposal; setup writes its own row). */
export async function applyDeploymentSettings(tx: DbOrTx, actor: ActorContext, input: DeploymentSettingsInput): Promise<DeploymentSettings> {
  const [before] = await tx.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1));
  const [after] = await tx
    .update(deploymentSettings)
    .set({ ...stripUndefined(input), updatedAt: new Date(), updatedBy: actor.principal?.userId ?? null })
    .where(eq(deploymentSettings.id, 1))
    .returning();
  await recordAudit(tx, actor, { action: 'deployment.settings_update', targetType: 'deployment', summary: 'Updated deployment settings', before, after: input });
  await emitEvent(tx, actor, 'config.changed', { area: 'deployment', entityId: null });
  return after!;
}

/** The worker settings a patch produces, validated as a whole (not just the patch). */
export function mergedWorkerSettings(before: WorkerSettings, input: WorkerSettingsInput): { ok: true } | { ok: false; message: string } {
  const check = WorkerSettingsInput.safeParse({ ...before, ...stripUndefined(input) });
  return check.success ? { ok: true } : { ok: false, message: check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

/** Apply a worker-settings patch (activation of an approved proposal). */
export async function applyWorkerSettings(tx: DbOrTx, actor: ActorContext, input: WorkerSettingsInput): Promise<WorkerSettings> {
  const [before] = await tx.select().from(workerSettings).where(eq(workerSettings.id, 1));
  const merged = mergedWorkerSettings(before!, input);
  if (!merged.ok) throw validation('invalid_worker_settings', merged.message);
  const [after] = await tx
    .update(workerSettings)
    .set({ ...stripUndefined(input), updatedAt: new Date(), updatedBy: actor.principal?.userId ?? null })
    .where(eq(workerSettings.id, 1))
    .returning();
  await recordAudit(tx, actor, { action: 'workers.config_update', targetType: 'worker_settings', summary: describeChange(before!, after!), before, after: input });
  await emitEvent(tx, actor, 'config.changed', { area: 'workers', entityId: null });
  return after!;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function describeChange(before: WorkerSettings, after: WorkerSettings): string {
  const keys = ['minWarmWorkers', 'maxWorkers', 'conversationsPerWorker', 'targetUtilization', 'scaleOutQueueAgeSeconds'] as const;
  const changes = keys.filter((k) => before[k] !== after[k]).map((k) => `${k} ${before[k]} → ${after[k]}`);
  return changes.length ? `Worker configuration: ${changes.join(', ')}` : 'Worker configuration updated';
}
