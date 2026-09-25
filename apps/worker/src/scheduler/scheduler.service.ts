import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AlertDeliveryService, AlertEngine, CustomerClaimsIssuer, RoutingEngine, ScalingService, autoAssignUnclaimed, recordWorkerHealthSample, expireOffers, pollPendingTemplates, repairStuckEscalations, RetentionService, SettingsService } from '@ocso/application';
import { ChannelRuntime, cleanupExpiredLeases, expireToolConfirmations, lostWorkerTimeoutSeconds, reapLostWorkers, relayScheduledJobs, requestResolvedInsights, sweepStrandedTurns, templateProviderSource } from '@ocso/agent-runtime';
import type { BlobStore } from '@ocso/blob';
import type { WorkerEnv } from '@ocso/config';
import { healthSamples, uuidv7, type Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import type { ProviderRegistry } from '@ocso/model-providers';
import { BLOB_STORE, DB, ENV, LOGGER, PROVIDER_REGISTRY, QUEUE, SECRET_STORE } from '../infrastructure/tokens.js';
import { ApprovalsWorker } from '../approvals/approvals.module.js';
import { AuditWorker } from '../audit/audit.module.js';
import { ExceptionsWorker } from '../exceptions/exceptions.module.js';
import { LeaderElection } from './leader.js';
import { subsystemTasks } from './tasks.registry.js';

export interface ScheduledTask {
  name: string;
  everySeconds: number;
  run(ctx: { db: Db; queue: QueueAdapter; correlationId: string }): Promise<unknown>;
}

/**
 * Leader-only periodic work (ADR-018). Every task is idempotent, so a
 * leadership change mid-interval is harmless.
 */
@Injectable()
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastRun = new Map<string, number>();
  private readonly leader: LeaderElection;
  private running = false;
  private readonly tasks: ScheduledTask[];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueueAdapter,
    @Inject(ENV) env: WorkerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(SECRET_STORE) secrets: SecretStore,
    @Inject(AlertEngine) alerts: AlertEngine,
    @Inject(AlertDeliveryService) alertDelivery: AlertDeliveryService,
    @Inject(CustomerClaimsIssuer) claims: CustomerClaimsIssuer,
    @Inject(ScalingService) scaling: ScalingService,
    @Inject(BLOB_STORE) blobs: BlobStore,
    @Inject(ChannelRuntime) channels: ChannelRuntime,
    @Inject(ApprovalsWorker) approvals: ApprovalsWorker,
    @Inject(AuditWorker) audit: AuditWorker,
    @Inject(RoutingEngine) routing: RoutingEngine,
    @Inject(ExceptionsWorker) exceptions: ExceptionsWorker,
    @Inject(PROVIDER_REGISTRY) providerRegistry: ProviderRegistry,
  ) {
    this.leader = new LeaderElection(env.DATABASE_URL, 'ocso:scheduler');
    this.tasks = [
      { name: 'sweep-stranded-turns', everySeconds: 5, run: ({ db, queue }) => sweepStrandedTurns(db, queue, { olderThanSeconds: 5, limit: 200 }) },
      { name: 'expire-offers', everySeconds: 5, run: ({ db }) => expireOffers(db) },
      { name: 'auto-assign', everySeconds: 5, run: ({ db }) => autoAssignUnclaimed(db) },
      { name: 'repair-escalations', everySeconds: 30, run: ({ db }) => repairStuckEscalations(db) },
      { name: 'expire-tool-confirmations', everySeconds: 30, run: ({ db }) => expireToolConfirmations(db) },
      { name: 'reap-lost-workers', everySeconds: 5, run: async ({ db }) => reapLostWorkers(db, lostWorkerTimeoutSeconds((await new SettingsService(db).workers()).heartbeatIntervalSeconds)) },
      { name: 'cleanup-leases', everySeconds: 60, run: ({ db }) => cleanupExpiredLeases(db) },
      { name: 'relay-scheduled-jobs', everySeconds: 5, run: ({ db, queue }) => relayScheduledJobs(db, queue) },
      { name: 'health-sample', everySeconds: 60, run: ({ db }) => sampleDatabaseHealth(db) },
      { name: 'worker-health-sample', everySeconds: 60, run: ({ db }) => recordWorkerHealthSample(db) },
      { name: 'request-insights', everySeconds: 30, run: ({ db, queue }) => requestResolvedInsights(db, queue) },
      { name: 'retention', everySeconds: 3600, run: ({ db }) => new RetentionService(db, blobs, (msg, err) => logger.warn({ err }, msg), audit.store).run() },
      // Message templates in review: ask the provider, record + announce status changes (docs/archive/specs/07 §3).
      { name: 'message-template-status', everySeconds: 180, run: ({ db, correlationId }) => pollPendingTemplates(db, templateProviderSource(channels), { correlationId }) },
      { name: 'purge-done-jobs', everySeconds: 3600, run: ({ db }) => db.execute(sql`DELETE FROM jobs WHERE status = 'done' AND completed_at < now() - interval '1 day'`) },
      ...subsystemTasks({ db, env, secrets, queue, alerts, alertDelivery, claims, scaling, approvals, audit, routing, exceptions, providers: providerRegistry.list() }),
    ];
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 1_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.leader.release();
  }

  get isLeader(): boolean {
    return this.leader.isLeader;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.leader.tick())) return;
      const now = Date.now();
      for (const task of this.tasks) {
        if (now - (this.lastRun.get(task.name) ?? 0) < task.everySeconds * 1000) continue;
        this.lastRun.set(task.name, now);
        try {
          await task.run({ db: this.db, queue: this.queue, correlationId: randomUUID() });
        } catch (err) {
          this.logger.error({ err, task: task.name }, 'scheduled task failed');
        }
      }
    } finally {
      this.running = false;
    }
  }
}

async function sampleDatabaseHealth(db: Db): Promise<void> {
  const started = performance.now();
  let status: 'OK' | 'DEGRADED' | 'DOWN' = 'OK';
  try {
    await db.execute(sql`SELECT 1`);
    if (performance.now() - started > 250) status = 'DEGRADED';
  } catch {
    status = 'DOWN';
  }
  await db.insert(healthSamples).values({ id: uuidv7(), component: 'database', status, latencyMs: Math.round(performance.now() - started) }).catch(() => {});
}
