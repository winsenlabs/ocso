import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@ocso/db';
import { SettingsService, type WorkerSettings } from '../settings/settings.js';
import { at, int, iso, num, ratio } from '../analytics/values.js';

export interface WorkerView {
  id: string;
  hostname: string;
  version: string;
  status: string;
  /** HEALTHY with a stale heartbeat is reported as STALE (not counted as healthy). */
  effectiveStatus: string;
  capacity: number;
  activeLeases: number;
  busyTurns: number;
  utilization: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  platformRef: string | null;
  startedAt: string;
  uptimeSeconds: number;
  heartbeatAt: string;
  heartbeatAgeSeconds: number;
}

export interface WorkerFleet {
  settings: WorkerSettings;
  /** Heartbeat freshness bound for "healthy": 3 × heartbeat interval. */
  healthyHeartbeatSeconds: number;
  workers: WorkerView[];
  healthy: number;
  slotsUsed: number;
  slotsTotal: number;
}

const STATUS_ORDER: Record<string, number> = { HEALTHY: 0, STALE: 1, DRAINING: 2, STARTING: 3, LOST: 4, STOPPED: 5 };

export const HEALTHY_DEFINITION =
  'A worker is healthy when status = HEALTHY and its heartbeat is at most 3 × worker_settings.heartbeat_interval_seconds old. Utilization = active_leases / capacity.';

/**
 * Worker registry snapshot (design/03 "Worker instances"): every worker that is
 * not STOPPED, plus workers stopped/lost within the last 24 h for context.
 */
export async function workerFleet(db: Db, now: Date): Promise<WorkerFleet> {
  const settings = await new SettingsService(db).workers();
  const fresh = settings.heartbeatIntervalSeconds * 3;
  const { rows } = await db.execute<{
    id: string; hostname: string; version: string; status: string; capacity: number; active_leases: number; busy_turns: number;
    cpu_percent: number | null; memory_mb: number | null; platform_ref: string | null; started_at: Date; heartbeat_at: Date; age: number; uptime: number;
  }>(sql`
    SELECT id, hostname, version, status, capacity, active_leases, busy_turns, cpu_percent, memory_mb, platform_ref, started_at, heartbeat_at,
           extract(epoch FROM ${at(now)} - heartbeat_at)::float8 AS age,
           extract(epoch FROM ${at(now)} - started_at)::float8 AS uptime
      FROM workers
     WHERE status <> 'STOPPED' OR heartbeat_at > ${at(now)} - interval '24 hours'`);
  const workers = rows.map((r): WorkerView => {
    const age = Math.max(0, Math.round(num(r.age) ?? 0));
    const stale = r.status === 'HEALTHY' && age > fresh;
    return {
      id: r.id,
      hostname: r.hostname,
      version: r.version,
      status: r.status,
      effectiveStatus: stale ? 'STALE' : r.status,
      capacity: int(r.capacity),
      activeLeases: int(r.active_leases),
      busyTurns: int(r.busy_turns),
      utilization: ratio(int(r.active_leases), int(r.capacity)),
      cpuPercent: num(r.cpu_percent),
      memoryMb: num(r.memory_mb),
      platformRef: r.platform_ref,
      startedAt: iso(r.started_at)!,
      uptimeSeconds: Math.max(0, Math.round(num(r.uptime) ?? 0)),
      heartbeatAt: iso(r.heartbeat_at)!,
      heartbeatAgeSeconds: age,
    };
  });
  // Healthy first, then stale/draining/starting/lost; oldest first within a status.
  workers.sort((a, b) => (STATUS_ORDER[a.effectiveStatus] ?? 9) - (STATUS_ORDER[b.effectiveStatus] ?? 9) || a.startedAt.localeCompare(b.startedAt));
  const healthy = workers.filter((w) => w.effectiveStatus === 'HEALTHY');
  return {
    settings,
    healthyHeartbeatSeconds: fresh,
    workers,
    healthy: healthy.length,
    slotsUsed: healthy.reduce((s, w) => s + w.activeLeases, 0),
    slotsTotal: healthy.reduce((s, w) => s + w.capacity, 0),
  };
}

export interface LeaseSummary {
  active: number;
  busy: number;
  slotsTotal: number;
  recoveredToday: number;
  leaseDurationSeconds: number;
  heartbeatIntervalSeconds: number;
  definitions: Record<string, string>;
}

/**
 * Conversation lease accounting. "Recovered" is derived from turns (no lease
 * history table): a conversation counts once per day when a turn started today
 * ran on a different worker than the conversation's previous turn and that
 * previous worker is now LOST with stopped_at before the new turn. Reads
 * turns_status_idx (status, started_at).
 */
export async function leaseSummary(db: DbOrTx, fleet: WorkerFleet, now: Date, dayStart: Date): Promise<LeaseSummary> {
  const [leases, recovered] = await Promise.all([
    db.execute<{ active: number; busy: number }>(sql`
      SELECT count(*)::int AS active, count(*) FILTER (WHERE busy)::int AS busy
        FROM conversation_leases WHERE expires_at > ${at(now)}`),
    db.execute<{ n: number }>(sql`
      WITH recent AS (
        SELECT conversation_id, worker_id, started_at,
               lag(worker_id) OVER (PARTITION BY conversation_id ORDER BY started_at) AS prev_worker
          FROM turns
         WHERE status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
           AND started_at >= ${at(dayStart)} - interval '1 day' AND started_at <= ${at(now)}
      )
      SELECT count(DISTINCT r.conversation_id)::int AS n
        FROM recent r
        JOIN workers w ON w.id = r.prev_worker
       WHERE r.started_at >= ${at(dayStart)} AND r.prev_worker <> r.worker_id
         AND w.status = 'LOST' AND w.stopped_at <= r.started_at`),
  ]);
  return {
    active: int(leases.rows[0]?.active),
    busy: int(leases.rows[0]?.busy),
    slotsTotal: fleet.slotsTotal,
    recoveredToday: int(recovered.rows[0]?.n),
    leaseDurationSeconds: fleet.settings.leaseDurationSeconds,
    heartbeatIntervalSeconds: fleet.settings.heartbeatIntervalSeconds,
    definitions: {
      active: 'conversation_leases with expires_at in the future (busy = a turn is executing).',
      slotsTotal: 'Sum of capacity over healthy workers.',
      recoveredToday:
        'Approximation from turns: conversations with a turn today on a different worker than their previous turn, where the previous worker is LOST and stopped before the new turn started.',
    },
  };
}
