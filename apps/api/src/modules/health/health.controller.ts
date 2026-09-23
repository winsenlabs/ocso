import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'drizzle-orm';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { Permission } from '@ocso/auth';
import { Public, RequirePermission } from '../../common/decorators.js';
import { DB, QUEUE } from '../../infrastructure/tokens.js';

/**
 * Health endpoints (docs/13 §6): liveness never depends on external services;
 * readiness requires PostgreSQL; dependency health is informational.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueueAdapter,
  ) {}

  @Get('live')
  @Public()
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string; database: string }> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: 'ready', database: 'ok' };
    } catch {
      res.status(503);
      return { status: 'not_ready', database: 'down' };
    }
  }

  /** Dependency latencies are operational detail: Tech Admin only (load balancers use /health/ready). */
  @Get('dependencies')
  @RequirePermission(Permission.SYSTEM_READ)
  async dependencies(): Promise<Record<string, { status: string; latencyMs?: number }>> {
    const timed = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      try {
        await fn();
        return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
      } catch {
        return { status: 'down' };
      }
    };
    return {
      database: await timed(() => this.db.execute(sql`SELECT 1`)),
      queue: await timed(() => this.queue.stats('conversation.turn')),
    };
  }
}
