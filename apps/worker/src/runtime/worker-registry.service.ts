import { Inject, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { eq, sql } from 'drizzle-orm';
import { workers, type Db } from '@ocso/db';
import type { WorkerEnv } from '@ocso/config';
import { DB, ENV, WORKER_ID } from '../infrastructure/tokens.js';

export type WorkerStatus = 'STARTING' | 'HEALTHY' | 'DRAINING' | 'STOPPED';

/** Worker registration and heartbeat row (design/03 "Worker instances"). */
@Injectable()
export class WorkerRegistryService {
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WORKER_ID) readonly workerId: string,
    @Inject(ENV) private readonly env: WorkerEnv,
  ) {}

  async register(capacity: number): Promise<void> {
    await this.db
      .insert(workers)
      .values({
        id: this.workerId,
        hostname: hostname(),
        version: this.env.APP_VERSION,
        status: 'STARTING',
        capacity,
        platformRef: process.env['ECS_CONTAINER_METADATA_URI_V4'] ? 'ecs' : 'compose',
      })
      .onConflictDoUpdate({ target: workers.id, set: { status: 'STARTING', startedAt: new Date(), heartbeatAt: new Date(), stoppedAt: null, capacity } });
  }

  async heartbeat(status: WorkerStatus, capacity: number, activeLeases: number, busyTurns: number): Promise<void> {
    await this.db
      .update(workers)
      .set({
        status,
        capacity,
        activeLeases,
        busyTurns,
        cpuPercent: this.cpuPercent(),
        memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
        heartbeatAt: sql`now()`,
        ...(status === 'STOPPED' ? { stoppedAt: new Date() } : {}),
      })
      .where(eq(workers.id, this.workerId));
  }

  private cpuPercent(): number {
    const now = performance.now();
    const usage = process.cpuUsage(this.lastCpu);
    const elapsedMicros = (now - this.lastCpuAt) * 1000;
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    return elapsedMicros > 0 ? Math.min(100, Math.round(((usage.user + usage.system) / elapsedMicros) * 1000) / 10) : 0;
  }
}
