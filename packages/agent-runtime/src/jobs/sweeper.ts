import { inArray, sql } from 'drizzle-orm';
import { conversationLeases, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';

/**
 * Liveness guarantee (docs/10 §9): finds conversations where AI owns the
 * conversation, a customer message is unanswered, no live busy lease exists
 * and no turn job is pending — then re-enqueues a turn. Covers crashes between
 * commit and publish, dead workers and dead-lettered jobs.
 */
export async function sweepStrandedTurns(db: Db, queue: QueueAdapter, options: { olderThanSeconds: number; limit: number }): Promise<string[]> {
  const { rows } = await db.execute<{ id: string; last_seq: number }>(sql`
    SELECT c.id, c.last_seq
      FROM conversations c
      JOIN virtual_agents a ON a.id = c.agent_id AND a.status = 'LIVE'
     WHERE c.control_state IN ('AI_ACTIVE', 'AI_RESUMING')
       AND EXISTS (
         SELECT 1 FROM interactions i
          WHERE i.conversation_id = c.id AND i.actor_type = 'CUSTOMER' AND i.kind = 'MESSAGE'
            AND i.seq > c.last_processed_seq
            AND i.created_at < now() - make_interval(secs => ${options.olderThanSeconds}))
       AND NOT EXISTS (
         SELECT 1 FROM conversation_leases l
          WHERE l.conversation_id = c.id AND l.busy AND l.expires_at > now())
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.topic = 'conversation.turn' AND j.group_key = c.id::text AND j.status IN ('queued', 'running'))
     ORDER BY c.last_interaction_at
     LIMIT ${options.limit}`);
  for (const row of rows) {
    await queue.publish('conversation.turn', { conversationId: row.id, seq: row.last_seq, sweep: true }, {
      groupKey: row.id,
      dedupeKey: `turn:${row.id}:${row.last_seq}`,
    });
  }
  return rows.map((r) => r.id);
}

/** Mark workers without a recent heartbeat as LOST and drop their leases (recovery). */
export async function reapLostWorkers(db: Db, heartbeatTimeoutSeconds: number): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(sql`
    UPDATE workers SET status = 'LOST', stopped_at = now()
     WHERE status IN ('STARTING', 'HEALTHY', 'DRAINING')
       AND heartbeat_at < now() - make_interval(secs => ${heartbeatTimeoutSeconds})
     RETURNING id`);
  if (rows.length) {
    await db.delete(conversationLeases).where(inArray(conversationLeases.workerId, rows.map((r) => r.id)));
  }
  return rows.length;
}

/** Expired idle leases carry no work; clean them so slot accounting stays accurate. */
export async function cleanupExpiredLeases(db: Db): Promise<number> {
  const { rowCount } = await db.execute(sql`DELETE FROM conversation_leases WHERE expires_at < now() - interval '5 minutes'`);
  return rowCount ?? 0;
}

/** Move due scheduled jobs (delays beyond the queue's limit) onto the queue. */
export async function relayScheduledJobs(db: Db, queue: QueueAdapter, limit = 100): Promise<number> {
  const { rows } = await db.execute<{ id: string; topic: string; payload: unknown; group_key: string | null; dedupe_key: string | null }>(sql`
    UPDATE scheduled_jobs SET dispatched_at = now()
     WHERE id IN (SELECT id FROM scheduled_jobs WHERE dispatched_at IS NULL AND run_at <= now() ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
     RETURNING id, topic, payload, group_key, dedupe_key`);
  for (const row of rows) {
    await queue.publish(row.topic as Parameters<QueueAdapter['publish']>[0], row.payload, {
      ...(row.group_key ? { groupKey: row.group_key } : {}),
      ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    });
  }
  return rows.length;
}
