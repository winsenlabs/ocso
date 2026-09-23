import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, iso } from '../analytics/values.js';
import { DEGRADED_MCP_STATUSES } from './mcp-health.js';
import type { QueueDepth } from './queue-depth.js';
import type { ModelWindowStats } from './tiles.js';
import type { WorkerFleet } from './workers.js';

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unknown';
export type ServiceKey = 'api' | 'runtime' | 'database' | 'queue' | 'providers' | 'mcp' | 'channels' | 'webhooks';

export interface ServiceChip {
  key: ServiceKey;
  label: string;
  status: ServiceStatus;
  detail: string;
  /** Rule that produced the status. */
  rule: string;
}

export interface StatusBar {
  overall: ServiceStatus;
  headline: string;
  healthy: number;
  degraded: number;
  chips: ServiceChip[];
}

/** Explicit thresholds (the rest come from worker_settings). */
export const STATUS_THRESHOLDS = {
  databaseSampleMaxAgeSeconds: 300,
  providerErrorRateDegraded: 0.05,
} as const;

const RANK: Record<ServiceStatus, number> = { unknown: 0, ok: 1, degraded: 2, down: 3 };

interface Inputs {
  fleet: WorkerFleet;
  queue: QueueDepth;
  model1h: ModelWindowStats;
  apiVersion: string | null;
}

/** Health facts the chips are derived from (all counts, no content). */
async function facts(db: DbOrTx, now: Date) {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [database, providers, mcp, channels, deliveries, webhooks] = await Promise.all([
    db.execute<{ status: string; latency_ms: number | null; sampled_at: Date }>(sql`
      SELECT status, latency_ms, sampled_at FROM health_samples WHERE component = 'database' AND sampled_at <= ${at(now)} ORDER BY sampled_at DESC LIMIT 1`),
    db.execute<{ status: string; n: number }>(sql`
      SELECT p.status, count(*)::int AS n FROM model_providers p
       WHERE p.enabled AND EXISTS (SELECT 1 FROM model_profiles mp WHERE mp.provider_id = p.id OR mp.fallbacks @> jsonb_build_array(jsonb_build_object('providerId', p.id::text)))
       GROUP BY p.status`),
    db.execute<{ total: number; degraded: number; down: number }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status IN (${sql.join(DEGRADED_MCP_STATUSES.map((s) => sql`${s}`), sql`, `)}))::int AS degraded,
             count(*) FILTER (WHERE status = 'DOWN')::int AS down
        FROM mcp_connections WHERE owner_user_id IS NULL AND scope = 'SHARED' AND status <> 'DISABLED'`),
    db.execute<{ total: number; active: number }>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'ACTIVE')::int AS active FROM channels`),
    db.execute<{ failed: number }>(sql`
      SELECT count(*)::int AS failed
        FROM conversations c JOIN interactions i ON i.conversation_id = c.id
       WHERE c.last_interaction_at >= ${at(hourAgo)} AND i.created_at >= ${at(hourAgo)} AND i.delivery_status = 'FAILED'`),
    db.execute<{ subs: number; failed: number }>(sql`
      SELECT (SELECT count(*)::int FROM webhook_subscriptions WHERE enabled) AS subs,
             (SELECT count(*)::int FROM webhook_deliveries d
               WHERE d.subscription_id IN (SELECT id FROM webhook_subscriptions) AND d.created_at >= ${at(hourAgo)} AND d.status = 'FAILED') AS failed`),
  ]);
  return { database: database.rows[0], providers: providers.rows, mcp: mcp.rows[0], channels: channels.rows[0], failedDeliveries: int(deliveries.rows[0]?.failed), webhooks: webhooks.rows[0] };
}

/** Status bar and per-service chips (design/03 top strip). Every status names the rule that produced it. */
export async function statusBar(db: DbOrTx, now: Date, input: Inputs): Promise<StatusBar> {
  const f = await facts(db, now);
  const { fleet, queue, model1h } = input;
  const s = fleet.settings;
  const chips: ServiceChip[] = [];

  chips.push({ key: 'api', label: 'API', status: 'ok', detail: input.apiVersion ? `serving · ${input.apiVersion}` : 'serving', rule: 'ok while this request is served' });

  const min = s.minWarmWorkers;
  chips.push({
    key: 'runtime',
    label: 'Agent runtime',
    status: fleet.healthy === 0 ? 'down' : fleet.healthy < min ? 'degraded' : 'ok',
    detail: `${fleet.healthy} healthy · min ${min} · max ${s.maxWorkers}`,
    rule: 'down when no healthy worker; degraded when healthy < worker_settings.min_warm_workers',
  });

  const dbAge = f.database ? (now.getTime() - new Date(f.database.sampled_at).getTime()) / 1000 : null;
  const dbFresh = dbAge !== null && dbAge <= STATUS_THRESHOLDS.databaseSampleMaxAgeSeconds;
  chips.push({
    key: 'database',
    label: 'PostgreSQL',
    status: !dbFresh ? 'unknown' : f.database!.status === 'OK' ? 'ok' : f.database!.status === 'DEGRADED' ? 'degraded' : 'down',
    detail: f.database ? `${f.database.status.toLowerCase()} · ${f.database.latency_ms ?? '—'} ms · sampled ${iso(f.database.sampled_at)}` : 'no health samples',
    rule: `latest 'database' health sample; unknown when older than ${STATUS_THRESHOLDS.databaseSampleMaxAgeSeconds}s`,
  });

  const turn = queue.turn;
  const slow = (turn.oldestAgeSeconds ?? 0) > s.scaleOutQueueAgeSeconds || turn.depth > s.scaleOutQueueDepth;
  chips.push({
    key: 'queue',
    label: 'Queue',
    status: slow ? 'degraded' : 'ok',
    detail: `depth ${queue.depth} · oldest ${queue.oldestAgeSeconds ?? 0}s · dead ${queue.dead}`,
    rule: 'degraded when the conversation.turn topic exceeds worker_settings.scale_out_queue_age_seconds or scale_out_queue_depth',
  });

  const used = f.providers.reduce((n, r) => n + int(r.n), 0);
  const count = (status: string) => int(f.providers.find((r) => r.status === status)?.n);
  const errorRate = model1h.errorRate ?? 0;
  chips.push({
    key: 'providers',
    label: 'Providers',
    status: used === 0 ? 'unknown' : count('DOWN') === used ? 'down' : count('DOWN') + count('DEGRADED') > 0 || errorRate > STATUS_THRESHOLDS.providerErrorRateDegraded ? 'degraded' : 'ok',
    detail: `${used - count('DOWN') - count('DEGRADED')} of ${used} ok · error rate 1h ${(errorRate * 100).toFixed(1)}%`,
    rule: `enabled providers referenced by a profile; down when all DOWN; degraded when any DEGRADED/DOWN or 1 h error rate > ${STATUS_THRESHOLDS.providerErrorRateDegraded * 100}%`,
  });

  const mcpTotal = int(f.mcp?.total);
  const mcpDegraded = int(f.mcp?.degraded);
  chips.push({
    key: 'mcp',
    label: 'MCP',
    status: mcpTotal === 0 ? 'unknown' : int(f.mcp?.down) === mcpTotal ? 'down' : mcpDegraded > 0 ? 'degraded' : 'ok',
    detail: `${mcpDegraded} of ${mcpTotal} degraded`,
    rule: `shared connections not DISABLED; degraded when any is ${DEGRADED_MCP_STATUSES.join('/')}`,
  });

  chips.push({
    key: 'channels',
    label: 'Channels',
    status: int(f.channels?.total) === 0 ? 'unknown' : f.failedDeliveries > 0 ? 'degraded' : 'ok',
    detail: `${int(f.channels?.active)} active · ${int(f.channels?.total) - int(f.channels?.active)} inactive · ${f.failedDeliveries} failed deliveries 1h`,
    rule: 'degraded when any outbound delivery FAILED in the last hour',
  });

  const subs = int(f.webhooks?.subs);
  const whFailed = int(f.webhooks?.failed);
  chips.push({
    key: 'webhooks',
    label: 'Webhooks',
    status: subs === 0 ? 'unknown' : whFailed > 0 ? 'degraded' : 'ok',
    detail: subs === 0 ? 'none configured' : `${subs} subscriptions · ${whFailed} failed deliveries 1h`,
    rule: 'degraded when any webhook delivery FAILED in the last hour',
  });

  const worst = chips.reduce<ServiceStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'ok');
  const affected = chips.filter((c) => c.status === 'degraded' || c.status === 'down').map((c) => c.label);
  const healthy = chips.filter((c) => c.status === 'ok').length;
  return {
    overall: worst,
    headline: worst === 'ok' ? 'All systems operational' : `${worst === 'down' ? 'Outage' : 'Degraded'} — ${affected.join(', ')}`,
    healthy,
    degraded: affected.length,
    chips,
  };
}

