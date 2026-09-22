import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { autoAssignUnclaimed, expireOffers, repairStuckEscalations } from '@ocso/application';
import { cleanupExpiredLeases, reapLostWorkers, relayScheduledJobs, sweepStrandedTurns } from '@ocso/agent-runtime';
import type { WorkerEnv } from '@ocso/config';
import { healthSamples, uuidv7, type Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import { DB, ENV, LOGGER, QUEUE } from '../infrastructure/tokens.js';
import { LeaderElection } from './leader.js';
import { EXTRA_TASKS } from './tasks.registry.js';

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
  ) {
    this.leader = new LeaderElection(env.DATABASE_URL, 'ocso:scheduler');
    this.tasks = [
      { name: 'sweep-stranded-turns', everySeconds: 5, run: ({ db, queue }) => sweepStrandedTurns(db, queue, { olderThanSeconds: 5, limit: 200 }) },
      { name: 'expire-offers', everySeconds: 5, run: ({ db }) => expireOffers(db) },
      { name: 'auto-assign', everySeconds: 5, run: ({ db }) => autoAssignUnclaimed(db) },
      { name: 'repair-escalations', everySeconds: 30, run: ({ db }) => repairStuckEscalations(db) },
      { name: 'reap-lost-workers', everySeconds: 15, run: ({ db }) => reapLostWorkers(db, 45) },
      { name: 'cleanup-leases', everySeconds: 60, run: ({ db }) => cleanupExpiredLeases(db) },
      { name: 'relay-scheduled-jobs', everySeconds: 5, run: ({ db, queue }) => relayScheduledJobs(db, queue) },
      { name: 'health-sample', everySeconds: 60, run: ({ db }) => sampleDatabaseHealth(db) },
      { name: 'purge-done-jobs', everySeconds: 3600, run: ({ db }) => db.execute(sql`DELETE FROM jobs WHERE status = 'done' AND completed_at < now() - interval '1 day'`) },
      ...EXTRA_TASKS,
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
