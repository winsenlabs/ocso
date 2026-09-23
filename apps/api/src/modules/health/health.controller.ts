import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { isNull, sql } from 'drizzle-orm';
import type { AuditStore } from '@ocso/application';
import { auditEvents, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { Permission } from '@ocso/auth';
import { Capability, Public, RequirePermission } from '../../common/decorators.js';
import { AUDIT_STORE, DB, QUEUE } from '../../infrastructure/tokens.js';

/**
 * Health endpoints (docs/13 §6): liveness never depends on external services;
 * readiness requires PostgreSQL — not the audit store (ADR-032: the outbox
 * holds events while it is away); dependency health is informational.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueueAdapter,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
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

  /** Dependency latencies are operational detail: Tech admin only (load balancers use /health/ready). */
  @Capability({ name: 'system.get_dependency_health', summary: "Health and latency of the platform's dependencies.", tags: ['health', 'status', 'dependencies'] })
  @Get('dependencies')
  @RequirePermission(Permission.SYSTEM_READ)
  async dependencies(): Promise<Record<string, { status: string; latencyMs?: number; driver?: string; lagSeconds?: number; unshipped?: number }>> {
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
      auditStore: await this.auditStoreHealth(),
    };
  }

  /** The audit store's reachability plus shipping lag (the age of the oldest event not in the store yet). */
  private async auditStoreHealth() {
    const health = await this.auditStore.health();
    const [lag] = await this.db
      .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${auditEvents.occurredAt})` })
      .from(auditEvents)
      .where(isNull(auditEvents.shippedAt))
      .catch(() => [null]);
    const lagSeconds = lag?.oldest ? Math.max(0, Math.round((Date.now() - new Date(lag.oldest).getTime()) / 1000)) : 0;
    return { status: health.ok ? 'ok' : 'down', latencyMs: health.latencyMs, driver: this.auditStore.driver, lagSeconds, unshipped: lag?.n ?? 0 };
  }
}
