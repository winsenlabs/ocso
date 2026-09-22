import { randomUUID } from 'node:crypto';
import type {
  ConsumeOptions,
  MessageHandler,
  PublishOptions,
  QueueAdapter,
  QueueStats,
  QueueSubscription,
  Topic,
} from '../contract.js';
import { ConsumerLoop, type ClaimedMessage, type MessageSource } from '../consumer-loop.js';
import type { SqlClient } from '../sql.js';
import { CLAIM_SQL, CLAIM_WITH_AFFINITY_SQL } from './sql-text.js';

export interface PgQueueOptions {
  workerId: string;
  /**
   * Conversation affinity (ADR-008): prefer jobs whose conversation lease this
   * worker holds, and skip jobs whose conversation is busy on another worker.
   * Requires the `conversation_leases` table.
   */
  conversationAffinityTopics?: readonly Topic[] | undefined;
  /** Optional wake-up channel (LISTEN/NOTIFY) to avoid polling latency. */
  notifier?: QueueNotifier | undefined;
}

export interface QueueNotifier {
  notify(topic: Topic): Promise<void>;
  onNotify(listener: (topic: Topic) => void): () => void;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  topic: Topic;
  payload: unknown;
  group_key: string | null;
  attempts: number;
  enqueued_at: Date;
}

/** PostgreSQL-backed queue for Compose deployments (`jobs` table, SKIP LOCKED). */
export class PgQueue implements QueueAdapter {
  readonly driver = 'postgres' as const;

  constructor(
    private readonly sql: SqlClient,
    private readonly options: PgQueueOptions,
  ) {}

  async publish<T>(topic: Topic, payload: T, opts: PublishOptions = {}): Promise<void> {
    await this.sql.query(
      `INSERT INTO jobs (id, topic, payload, group_key, dedupe_key, available_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, now() + make_interval(secs => $6))
       ON CONFLICT (topic, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING`,
      [randomUUID(), topic, JSON.stringify(payload ?? null), opts.groupKey ?? null, opts.dedupeKey ?? null, opts.delaySeconds ?? 0],
    );
    if (!opts.delaySeconds) await this.options.notifier?.notify(topic);
  }

  consume<T>(topic: Topic, handler: MessageHandler<T>, options: ConsumeOptions): QueueSubscription {
    const loop = new ConsumerLoop<T>(this.source<T>(topic, options), handler, options);
    const unsubscribe = this.options.notifier?.onNotify((t) => {
      if (t === topic) loop.wake();
    });
    loop.start();
    return {
      stop: async () => {
        unsubscribe?.();
        await loop.stop();
      },
      get inFlight() {
        return loop.inFlight;
      },
    };
  }

  async stats(topic: Topic): Promise<QueueStats> {
    const { rows } = await this.sql.query<{ depth: string; in_flight: string; dead: string; oldest: number | null }>(
      `SELECT count(*) FILTER (WHERE status = 'queued' AND available_at <= now()) AS depth,
              count(*) FILTER (WHERE status = 'running') AS in_flight,
              count(*) FILTER (WHERE status = 'dead') AS dead,
              extract(epoch FROM now() - min(enqueued_at) FILTER (WHERE status = 'queued' AND available_at <= now()))::float8 AS oldest
         FROM jobs WHERE topic = $1`,
      [topic],
    );
    const r = rows[0]!;
    return { depth: Number(r.depth), inFlight: Number(r.in_flight), dead: Number(r.dead), oldestAgeSeconds: r.oldest };
  }

  private source<T>(topic: Topic, options: ConsumeOptions): MessageSource<T> {
    const workerId = this.options.workerId;
    const affinity = this.options.conversationAffinityTopics?.includes(topic) ?? false;
    const sql = this.sql;
    return {
      async claim(max: number): Promise<Array<ClaimedMessage<T>>> {
        const { rows } = await sql.query<JobRow>(affinity ? CLAIM_WITH_AFFINITY_SQL : CLAIM_SQL, [
          topic,
          max,
          workerId,
          options.visibilityTimeoutSeconds,
        ]);
        return rows.map((row) => ({
          receipt: row.id,
          message: {
            id: row.id,
            topic: row.topic,
            payload: row.payload as T,
            groupKey: row.group_key,
            attempt: row.attempts,
            enqueuedAt: new Date(row.enqueued_at),
          },
        }));
      },
      async ack(receipt) {
        await sql.query(
          `UPDATE jobs SET status = 'done', completed_at = now(), locked_by = NULL, locked_until = NULL
            WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
          [receipt, workerId],
        );
      },
      async release(receipt, delaySeconds, error, countAttempt, dead) {
        await sql.query(
          `UPDATE jobs SET status = CASE WHEN $5 THEN 'dead' ELSE 'queued' END,
                  available_at = now() + make_interval(secs => $3),
                  attempts = attempts - CASE WHEN $6 THEN 0 ELSE 1 END,
                  last_error = COALESCE($4, last_error), locked_by = NULL, locked_until = NULL
            WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
          [receipt, workerId, delaySeconds, error, dead, countAttempt],
        );
      },
      async extend(receipt, seconds) {
        await sql.query(
          `UPDATE jobs SET locked_until = now() + make_interval(secs => $3)
            WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
          [receipt, workerId, seconds],
        );
      },
    };
  }
}
