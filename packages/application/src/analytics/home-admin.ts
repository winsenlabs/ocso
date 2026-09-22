import { sql } from 'drizzle-orm';
import type { Db } from '@ocso/db';
import { DEGRADED_MCP_STATUSES } from '../telemetry/mcp-health.js';
import { privilegedChanges, type PrivilegedChange } from '../telemetry/privileged-changes.js';
import { queueDepth, type QueueStatsSource } from '../telemetry/queue-depth.js';
import { activeConversations, modelWindowStats } from '../telemetry/tiles.js';
import { tokenUsage } from '../telemetry/token-usage.js';
import { uptime, type Uptime } from '../telemetry/uptime.js';
import { workerFleet } from '../telemetry/workers.js';
import { at, int, iso, ratio } from './values.js';

export interface AdminHome {
  uptime: Uptime;
  tiles: {
    healthyWorkers: { healthy: number; max: number; minWarm: number };
    activeConversations: number;
    ttftP95Ms: number | null;
    tokensToday: number;
    openIncidents: number;
  };
  incidents: {
    open: number;
    critical: number;
    items: Array<{ id: string; title: string; severity: string; source: string; status: string; value: string | null; openedAt: string; lastSeenAt: string; occurrences: number }>;
  };
  capacity: { slotsUsed: number; slotsTotal: number; utilization: number | null; queueDepth: number; oldestAgeSeconds: number | null; warmFloor: number; ceiling: number };
  connections: {
    mcp: { servers: number; tools: number; degraded: number };
    providers: { providers: number; profiles: number; degraded: number };
    channels: { channels: number; active: number; failedDeliveries1h: number };
  };
  recentChanges: PrivilegedChange[];
  definitions: Record<string, string>;
}

/**
 * Tech Admin home (design/06 admin). Platform health only: counts, timings,
 * technical alerts and privileged configuration changes — no conversation
 * content, customer names or previews.
 */
export async function adminHome(db: Db, now: Date, dayStart: Date, queueStats?: QueueStatsSource): Promise<AdminHome> {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [up, fleet, queue, active, model, today, incidents, connections, changes] = await Promise.all([
    uptime(db, now),
    workerFleet(db, now),
    queueDepth(db, now, queueStats),
    activeConversations(db),
    modelWindowStats(db, hourAgo, now),
    tokenUsage(db, dayStart, now),
    db.execute<{ id: string; title: string; severity: string; source: string; status: string; value: string | null; opened_at: Date; last_seen_at: Date; occurrences: number; open_n: number; critical_n: number }>(sql`
      SELECT id, title, severity, source, status, value, opened_at, last_seen_at, occurrences,
             (count(*) OVER ())::int AS open_n,
             (count(*) FILTER (WHERE severity = 'CRITICAL') OVER ())::int AS critical_n
        FROM alerts
       WHERE status IN ('OPEN', 'ACKNOWLEDGED') AND kind = 'TECHNICAL'
       ORDER BY (severity = 'CRITICAL') DESC, opened_at DESC
       LIMIT 10`),
    db.execute<{ mcp_servers: number; mcp_tools: number; mcp_degraded: number; providers: number; profiles: number; providers_degraded: number; channels: number; channels_active: number; failed: number }>(sql`
      SELECT (SELECT count(*)::int FROM mcp_connections WHERE owner_user_id IS NULL AND status <> 'DISABLED') AS mcp_servers,
             (SELECT count(*)::int FROM tools t JOIN mcp_connections m ON m.id = t.connection_id
               WHERE m.owner_user_id IS NULL AND t.approved AND t.enabled AND t.removed_at IS NULL) AS mcp_tools,
             (SELECT count(*)::int FROM mcp_connections WHERE owner_user_id IS NULL
               AND status IN (${sql.join(DEGRADED_MCP_STATUSES.map((s) => sql`${s}`), sql`, `)})) AS mcp_degraded,
             (SELECT count(*)::int FROM model_providers WHERE enabled) AS providers,
             (SELECT count(*)::int FROM model_profiles) AS profiles,
             (SELECT count(*)::int FROM model_providers WHERE enabled AND status IN ('DEGRADED', 'DOWN')) AS providers_degraded,
             (SELECT count(*)::int FROM channels) AS channels,
             (SELECT count(*)::int FROM channels WHERE status = 'ACTIVE') AS channels_active,
             (SELECT count(*)::int FROM conversations c JOIN interactions i ON i.conversation_id = c.id
               WHERE c.last_interaction_at >= ${at(hourAgo)} AND i.created_at >= ${at(hourAgo)} AND i.delivery_status = 'FAILED') AS failed`),
    privilegedChanges(db, 8),
  ]);
  const c = connections.rows[0];
  const t = today.totals;
  const openIncidents = int(incidents.rows[0]?.open_n);
  return {
    uptime: up,
    tiles: {
      healthyWorkers: { healthy: fleet.healthy, max: fleet.settings.maxWorkers, minWarm: fleet.settings.minWarmWorkers },
      activeConversations: active,
      ttftP95Ms: model.ttftP95Ms,
      tokensToday: t.inputTokens + t.outputTokens,
      openIncidents,
    },
    incidents: {
      open: openIncidents,
      critical: int(incidents.rows[0]?.critical_n),
      items: incidents.rows.map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        source: r.source,
        status: r.status,
        value: r.value,
        openedAt: iso(r.opened_at)!,
        lastSeenAt: iso(r.last_seen_at)!,
        occurrences: int(r.occurrences),
      })),
    },
    capacity: {
      slotsUsed: fleet.slotsUsed,
      slotsTotal: fleet.slotsTotal,
      utilization: ratio(fleet.slotsUsed, fleet.slotsTotal),
      queueDepth: queue.depth,
      oldestAgeSeconds: queue.oldestAgeSeconds,
      warmFloor: fleet.settings.minWarmWorkers,
      ceiling: fleet.settings.maxWorkers,
    },
    connections: {
      mcp: { servers: int(c?.mcp_servers), tools: int(c?.mcp_tools), degraded: int(c?.mcp_degraded) },
      providers: { providers: int(c?.providers), profiles: int(c?.profiles), degraded: int(c?.providers_degraded) },
      channels: { channels: int(c?.channels), active: int(c?.channels_active), failedDeliveries1h: int(c?.failed) },
    },
    recentChanges: changes,
    definitions: {
      openIncidents: 'TECHNICAL alerts with status OPEN or ACKNOWLEDGED.',
      slotsUsed: 'Sum of active_leases over healthy workers; slotsTotal = sum of their capacity.',
      ttftP95Ms: 'p95 of usage_events.ttft_ms for successful TURN requests in the last hour.',
      tokensToday: 'Input + output tokens since the start of today (deployment timezone).',
    },
  };
}
