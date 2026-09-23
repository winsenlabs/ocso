import { eq } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { validation } from '@ocso/domain';
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
  /** Days the main database keeps audit events the audit store verified (ADR-032); the database refuses < 30. */
  auditLocalWindowDays: z.number().int().min(90).max(3650).optional(),
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

  async updateDeployment(actor: ActorContext, input: DeploymentSettingsInput): Promise<DeploymentSettings> {
    assertCan(actor.principal!, Permission.DEPLOYMENT_SETTINGS_MANAGE);
    return this.db.transaction(async (tx) => {
      const before = await this.deployment(tx);
      const [after] = await tx
        .update(deploymentSettings)
        .set({ ...stripUndefined(input), updatedAt: new Date(), updatedBy: actor.principal!.userId })
        .where(eq(deploymentSettings.id, 1))
        .returning();
      await recordAudit(tx, actor, { action: 'deployment.settings_update', targetType: 'deployment', summary: 'Updated deployment settings', before, after: input });
      await emitEvent(tx, actor, 'config.changed', { area: 'deployment', entityId: null });
      return after!;
    });
  }

  async updateWorkers(actor: ActorContext, input: WorkerSettingsInput): Promise<WorkerSettings> {
    assertCan(actor.principal!, Permission.SYSTEM_CONFIGURE);
    return this.db.transaction(async (tx) => {
      const before = await this.workers(tx);
      const merged = { ...before, ...stripUndefined(input) };
      // Validate the merged result, not just the patch.
      const check = WorkerSettingsInput.safeParse(merged);
      if (!check.success) {
        throw validation('invalid_worker_settings', check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      }
      const [after] = await tx
        .update(workerSettings)
        .set({ ...stripUndefined(input), updatedAt: new Date(), updatedBy: actor.principal!.userId })
        .where(eq(workerSettings.id, 1))
        .returning();
      await recordAudit(tx, actor, {
        action: 'workers.config_update',
        targetType: 'worker_settings',
        summary: describeChange(before, after!),
        before,
        after: input,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'workers', entityId: null });
      return after!;
    });
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function describeChange(before: WorkerSettings, after: WorkerSettings): string {
  const keys = ['minWarmWorkers', 'maxWorkers', 'conversationsPerWorker', 'targetUtilization', 'scaleOutQueueAgeSeconds'] as const;
  const changes = keys.filter((k) => before[k] !== after[k]).map((k) => `${k} ${before[k]} → ${after[k]}`);
  return changes.length ? `Worker configuration: ${changes.join(', ')}` : 'Worker configuration updated';
}
