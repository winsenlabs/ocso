import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import type { ScalingSample } from '@ocso/deployment';
import type { QueueAdapter, QueueStats } from '@ocso/queue';
import { at } from '../analytics/values.js';

/** Window for the TurnLatencyP95 signal. */
export const TURN_LATENCY_WINDOW_SECONDS = 300;

export interface ScalingSampleDetail extends ScalingSample {
  /** Ready conversation.turn wake-ups. */
  queuedTurns: number;
  /** Where the queue figures came from: the queue driver, or PostgreSQL when the driver cannot say. */
  sources: { depth: 'queue' | 'postgres'; age: 'queue' | 'postgres' };
}

/**
 * One scaling sample from PostgreSQL truth (ADR-023, docs/10 §6):
 * - TurnsInFlight = busy conversation leases (a turn is executing);
 * - SlotDemand = TurnsInFlight + ready conversation.turn wake-ups (queue.stats);
 * - Workers = HEALTHY workers whose heartbeat is ≤ 3 × heartbeat interval old
 *   (same definition as the telemetry fleet view);
 * - OldestQueueAgeSeconds = the queue driver's oldest ready turn. Drivers
 *   whose stats cannot tell (`reportsOldestAge: false`, e.g. SQS: that age is
 *   a CloudWatch metric) get it from PostgreSQL instead: the oldest
 *   unprocessed customer message in an AI-controlled conversation with no
 *   turn running — the stranded-turn sweeper's predicate;
 * - TurnLatencyP95 = p95 of turns.latency_ms completed in the last 5 minutes.
 * If queue.stats fails, depth and age both come from that PostgreSQL query,
 * so the leader still publishes (missing data would stall target tracking).
 */
export async function computeScalingSample(
  db: DbOrTx,
  queue: Pick<QueueAdapter, 'stats' | 'reportsOldestAge'>,
  now: Date = new Date(),
): Promise<ScalingSampleDetail> {
  const [fleet, stats] = await Promise.all([fleetFigures(db, now), queue.stats('conversation.turn').catch((): QueueStats | null => null)]);
  const ageFromQueue = stats !== null && (stats.oldestAgeSeconds !== null || queue.reportsOldestAge);
  const waiting = stats && ageFromQueue ? null : await waitingTurns(db, now);
  const queuedTurns = stats ? stats.depth : (waiting?.count ?? 0);
  const oldest = ageFromQueue ? (stats?.oldestAgeSeconds ?? 0) : (waiting?.oldestSeconds ?? 0);
  return {
    at: now,
    slotDemand: fleet.turnsInFlight + queuedTurns,
    workers: fleet.workers,
    oldestQueueAgeSeconds: Math.max(0, Math.round(oldest * 10) / 10),
    turnsInFlight: fleet.turnsInFlight,
    turnLatencyP95Ms: fleet.p95 === null ? null : Math.round(fleet.p95),
    queuedTurns,
    sources: { depth: stats ? 'queue' : 'postgres', age: ageFromQueue ? 'queue' : 'postgres' },
  };
}

async function fleetFigures(db: DbOrTx, now: Date): Promise<{ turnsInFlight: number; workers: number; p95: number | null }> {
  const { rows } = await db.execute<{ in_flight: number; workers: number; p95: number | null }>(sql`
    SELECT
      (SELECT count(*) FROM conversation_leases WHERE busy AND expires_at > ${at(now)})::int AS in_flight,
      (SELECT count(*) FROM workers
        WHERE status = 'HEALTHY'
          AND heartbeat_at >= ${at(now)} - make_interval(secs => 3 * coalesce((SELECT heartbeat_interval_seconds FROM worker_settings WHERE id = 1), 10))
      )::int AS workers,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FROM turns
        WHERE status = 'COMPLETED' AND latency_ms IS NOT NULL
          AND completed_at > ${at(now)} - make_interval(secs => ${TURN_LATENCY_WINDOW_SECONDS}) AND completed_at <= ${at(now)}
      )::float8 AS p95`);
  const r = rows[0];
  return { turnsInFlight: Number(r?.in_flight ?? 0), workers: Number(r?.workers ?? 0), p95: r?.p95 == null ? null : Number(r.p95) };
}

/** Conversations waiting for a turn, by the same predicate as the stranded-turn sweeper. */
async function waitingTurns(db: DbOrTx, now: Date): Promise<{ count: number; oldestSeconds: number | null }> {
  const { rows } = await db.execute<{ n: number; oldest: number | null }>(sql`
    SELECT count(DISTINCT c.id)::int AS n,
           extract(epoch FROM ${at(now)} - min(i.created_at))::float8 AS oldest
      FROM conversations c
      JOIN virtual_agents a ON a.id = c.agent_id AND a.status = 'LIVE'
      JOIN interactions i ON i.conversation_id = c.id AND i.actor_type = 'CUSTOMER' AND i.kind = 'MESSAGE' AND i.seq > c.last_processed_seq
     WHERE c.control_state IN ('AI_ACTIVE', 'AI_RESUMING')
       AND NOT EXISTS (
         SELECT 1 FROM conversation_leases l WHERE l.conversation_id = c.id AND l.busy AND l.expires_at > ${at(now)})`);
  const r = rows[0];
  return { count: Number(r?.n ?? 0), oldestSeconds: r?.oldest == null ? null : Math.max(0, Number(r.oldest)) };
}
