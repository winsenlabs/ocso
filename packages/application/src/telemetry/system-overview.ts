import { sql } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import type { Db } from '@ocso/db';
import { z } from 'zod';
import { SettingsService } from '../settings/settings.js';
import { iso, startOfDay } from '../analytics/values.js';
import { latencySeries, type LatencySeries } from './latency-series.js';
import { mcpHealth } from './mcp-health.js';
import { privilegedChanges, type PrivilegedChange } from './privileged-changes.js';
import { providerHealth, type ProviderHealthCard } from './provider-health.js';
import { queueDepth, type QueueDepth, type QueueStatsSource } from './queue-depth.js';
import { statusBar, type StatusBar } from './status-bar.js';
import { modelWindowStats, telemetryTiles, type TelemetryTiles } from './tiles.js';
import { tokenUsage, type TokenUsage } from './token-usage.js';
import { uptime, type Uptime } from './uptime.js';
import { HEALTHY_DEFINITION, leaseSummary, workerFleet, type LeaseSummary, type WorkerView } from './workers.js';

export const LatencyQuery = z.object({ minutes: z.coerce.number().int().min(5).max(360).default(60) });
export type LatencyQuery = z.infer<typeof LatencyQuery>;
export const ChangesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
export type ChangesQuery = z.infer<typeof ChangesQuery>;

export interface TelemetryOptions {
  /** OCSO_TRACE_URL_TEMPLATE, e.g. `http://localhost:16686/trace/{traceId}`. */
  traceUrlTemplate?: string | null | undefined;
  apiVersion?: string | null | undefined;
  /** QueueAdapter.stats; falls back to the Postgres jobs table. */
  queueStats?: QueueStatsSource | undefined;
  /** Tile window (design/03 "Last 1h"). */
  windowMinutes?: number | undefined;
}

export interface SystemOverview {
  generatedAt: string;
  status: StatusBar;
  uptime: Uptime;
  tiles: TelemetryTiles;
  queue: QueueDepth;
  traceUrlTemplate: string | null;
}

export interface WorkersView {
  workers: WorkerView[];
  healthy: number;
  leases: LeaseSummary;
  config: Awaited<ReturnType<SettingsService['workers']>> & { lastChange: { at: string; actorName: string | null; summary: string } | null };
  definition: string;
}

/**
 * Platform Tech Admin control center (design/03, docs/11 §2). Technical
 * telemetry only: ids, counts, timings, tokens — never conversation content.
 * Every method requires telemetry.technical.read.
 */
export class SystemOverviewService {
  private readonly options: TelemetryOptions;

  constructor(
    private readonly db: Db,
    options: TelemetryOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.options = options;
  }

  async overview(principal: Principal): Promise<SystemOverview> {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    const now = this.now();
    const windowMinutes = this.options.windowMinutes ?? 60;
    const dayStart = await this.dayStart(now);
    const [fleet, queue, today, model1h, up] = await Promise.all([
      workerFleet(this.db, now),
      queueDepth(this.db, now, this.options.queueStats),
      tokenUsage(this.db, dayStart, now),
      modelWindowStats(this.db, new Date(now.getTime() - 3_600_000), now),
      uptime(this.db, now),
    ]);
    const [status, tiles] = await Promise.all([
      statusBar(this.db, now, { fleet, queue, model1h, apiVersion: this.options.apiVersion ?? null }),
      telemetryTiles(this.db, now, windowMinutes, { fleet, queue, today }),
    ]);
    return { generatedAt: now.toISOString(), status, uptime: up, tiles, queue, traceUrlTemplate: this.options.traceUrlTemplate ?? null };
  }

  async latency(principal: Principal, minutes = 60): Promise<LatencySeries> {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    return latencySeries(this.db, this.now(), minutes, this.options.traceUrlTemplate ?? null);
  }

  /** Token and cache usage since the start of today (deployment timezone). */
  async usage(principal: Principal): Promise<TokenUsage> {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    const now = this.now();
    return tokenUsage(this.db, await this.dayStart(now), now);
  }

  async workers(principal: Principal): Promise<WorkersView> {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    const now = this.now();
    const fleet = await workerFleet(this.db, now);
    const [leases, last] = await Promise.all([
      leaseSummary(this.db, fleet, now, await this.dayStart(now)),
      this.db.execute<{ occurred_at: Date; actor_name: string | null; summary: string }>(sql`
        SELECT occurred_at, actor_name, summary FROM audit_events WHERE target_type = 'worker_settings' ORDER BY occurred_at DESC LIMIT 1`),
    ]);
    const change = last.rows[0];
    return {
      workers: fleet.workers,
      healthy: fleet.healthy,
      leases,
      config: { ...fleet.settings, lastChange: change ? { at: iso(change.occurred_at)!, actorName: change.actor_name, summary: change.summary } : null },
      definition: HEALTHY_DEFINITION,
    };
  }

  async providers(principal: Principal): Promise<{ providers: ProviderHealthCard[] }> {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    const now = this.now();
    return { providers: await providerHealth(this.db, now, await this.dayStart(now)) };
  }

  async mcp(principal: Principal) {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    return mcpHealth(this.db, this.now());
  }

  async changes(principal: Principal, limit = 20): Promise<{ changes: PrivilegedChange[] }> {
    assertCan(principal, Permission.TELEMETRY_TECHNICAL_READ);
    return { changes: await privilegedChanges(this.db, limit) };
  }

  private async dayStart(now: Date): Promise<Date> {
    const { timezone } = await new SettingsService(this.db).deployment();
    return startOfDay(this.db, now, timezone);
  }
}
