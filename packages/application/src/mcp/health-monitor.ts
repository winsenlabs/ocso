import { desc, eq, sql } from 'drizzle-orm';
import { mcpConnections, mcpHealthSamples, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { McpHealthService, type McpHealthResult, type McpHealthStatus } from '@ocso/mcp';
import { emitEvent } from '../events/outbox.js';
import { systemActor, type ActorContext } from '../shared/context.js';
import { assertCanOperate, assertCanView } from './access.js';
import { SecretCredentialPort } from './credentials.js';
import { usabilityChanged } from './discovery-runner.js';
import { loadEgressPolicy } from './egress.js';
import { affectedAgentIds, bumpAgents, connectionTarget, loadConnection, type ConnectionRow, type ConnectionStatus, type McpContext } from './records.js';

export interface HealthCheckOutcome {
  connectionId: string;
  health: McpHealthStatus | 'SKIPPED';
  previousStatus: ConnectionStatus;
  status: ConnectionStatus;
  changed: boolean;
  latencyMs: number | null;
  detail: string;
}

export interface HealthSampleView {
  status: string;
  latencyMs: number | null;
  detail: string | null;
  sampledAt: string;
}

const STATUS_OF: Readonly<Record<McpHealthStatus, ConnectionStatus>> = {
  HEALTHY: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
};

/**
 * Connection health (wizard step 6 onwards): `server/discover` or `ping` via
 * McpHealthService, a sample per check, and ACTIVE ↔ DEGRADED ↔ DOWN ↔
 * AUTH_REQUIRED transitions (expired tokens whose refresh fails end in
 * AUTH_REQUIRED). Refreshed tokens are persisted by compare-and-swap.
 */
export class McpHealthMonitor {
  constructor(private readonly ctx: McpContext) {}

  /** Manual check from the UI. */
  async check(actor: ActorContext, connectionId: string): Promise<HealthCheckOutcome> {
    assertCanOperate(actor, await loadConnection(this.ctx.db, connectionId));
    return this.runHealthCheck(connectionId, actor);
  }

  async runHealthCheck(connectionId: string, actor: ActorContext = systemActor('mcp-health', `mcp-health-${connectionId}`)): Promise<HealthCheckOutcome> {
    const row = await loadConnection(this.ctx.db, connectionId);
    if (row.status === 'DISABLED') {
      return { connectionId, health: 'SKIPPED', previousStatus: row.status, status: row.status, changed: false, latencyMs: null, detail: 'disabled' };
    }
    const credentials = new SecretCredentialPort(this.ctx.db, this.ctx.secrets);
    const egress = await loadEgressPolicy(this.ctx.db, row.network);
    const service = new McpHealthService({ credentials, egress, resolver: this.ctx.resolver, limits: this.ctx.limits });
    const result = await service.health(connectionTarget(row), this.ctx.health);
    return this.record(actor, row.id, result);
  }

  /**
   * Scheduler entry point (worker leader, ADR-018): claim connections whose
   * `lastHealthAt + healthCheckSeconds` has passed with SKIP LOCKED (safe if
   * two schedulers overlap), then check them with bounded concurrency.
   * Unapproved drafts and USER-scope templates are never probed.
   */
  async runDueHealthChecks(options: { limit?: number; concurrency?: number } = {}): Promise<HealthCheckOutcome[]> {
    const now = this.ctx.now();
    const claimed = await this.ctx.db.execute<{ id: string }>(sql`
      UPDATE mcp_connections SET last_health_at = ${now}
      WHERE id IN (
        SELECT id FROM mcp_connections
        WHERE status <> 'DISABLED' AND approved_at IS NOT NULL
          AND NOT (scope = 'USER' AND owner_user_id IS NULL)
          AND (last_health_at IS NULL OR last_health_at + make_interval(secs => health_check_seconds) < ${now})
        ORDER BY last_health_at NULLS FIRST
        LIMIT ${options.limit ?? 50}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    const ids = claimed.rows.map((r) => r.id);
    const outcomes: HealthCheckOutcome[] = [];
    const concurrency = Math.max(1, options.concurrency ?? 8);
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency).map((id) => this.runHealthCheck(id).catch(() => null));
      for (const outcome of await Promise.all(batch)) if (outcome) outcomes.push(outcome);
    }
    return outcomes;
  }

  async history(actor: ActorContext, connectionId: string, limit = 100): Promise<HealthSampleView[]> {
    assertCanView(actor, await loadConnection(this.ctx.db, connectionId));
    const rows = await this.ctx.db
      .select()
      .from(mcpHealthSamples)
      .where(eq(mcpHealthSamples.connectionId, connectionId))
      .orderBy(desc(mcpHealthSamples.sampledAt))
      .limit(Math.min(Math.max(1, limit), 1_000));
    return rows.map((r) => ({ status: r.status, latencyMs: r.latencyMs, detail: r.detail, sampledAt: r.sampledAt.toISOString() }));
  }

  /** Runtime signal from a tool provider: see {@link recordConnectionAuthFailure}. */
  recordAuthFailure(connectionId: string, correlationId: string): Promise<void> {
    return recordConnectionAuthFailure(this.ctx.db, connectionId, correlationId, this.ctx.now);
  }

  private async record(actor: ActorContext, id: string, result: McpHealthResult): Promise<HealthCheckOutcome> {
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (tx) => {
      const row = await loadConnection(tx, id, { lock: true });
      await tx.insert(mcpHealthSamples).values({ id: uuidv7(), connectionId: id, status: result.status, latencyMs: result.latencyMs, detail: result.detail, sampledAt: now });
      // Drafts keep their wizard status; only approved connections follow health.
      const status = row.status === 'DISABLED' || !row.approvedAt ? row.status : STATUS_OF[result.status];
      await tx
        .update(mcpConnections)
        .set({
          lastHealthAt: now,
          lastHealthStatus: result.status,
          lastHealthLatencyMs: result.latencyMs,
          lastError: result.status === 'HEALTHY' ? null : `Health check: ${result.detail}`,
          status,
          ...(result.authRequired ? { serverInfo: { ...row.serverInfo, authRequired: result.authRequired } } : {}),
          ...(status !== row.status ? { updatedAt: now } : {}),
        })
        .where(eq(mcpConnections.id, id));
      if (status !== row.status) await onStatusChange(tx, actor, row, status);
      return {
        connectionId: id,
        health: result.status,
        previousStatus: row.status,
        status,
        changed: status !== row.status,
        latencyMs: result.latencyMs,
        detail: result.detail,
      };
    });
  }
}

async function onStatusChange(tx: DbOrTx, actor: Pick<ActorContext, 'correlationId'>, row: ConnectionRow, next: ConnectionStatus): Promise<void> {
  await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: row.id });
  if (usabilityChanged(row.status, next)) {
    await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [row.id], row.allowedAgentIds));
  }
}

/**
 * Runtime signal: the server rejected a connection's credentials during a
 * tool call. Approved, usable connections flip to AUTH_REQUIRED (an admin or
 * the owner must re-authenticate); the change is evented and invalidates the
 * affected agents' catalogues.
 */
export async function recordConnectionAuthFailure(db: Db, connectionId: string, correlationId: string, now: () => Date = () => new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await loadConnection(tx, connectionId, { lock: true }).catch(() => null);
    if (!row || (row.status !== 'ACTIVE' && row.status !== 'DEGRADED')) return;
    await tx
      .update(mcpConnections)
      .set({ status: 'AUTH_REQUIRED', lastError: 'Server rejected the stored credentials', updatedAt: now() })
      .where(eq(mcpConnections.id, connectionId));
    await onStatusChange(tx, { correlationId }, row, 'AUTH_REQUIRED');
  });
}
