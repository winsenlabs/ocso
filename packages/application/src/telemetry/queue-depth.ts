import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { TOPICS, type QueueStats, type Topic } from '@ocso/queue';
import { at, int, num } from '../analytics/values.js';

/** Injected queue statistics (QueueAdapter.stats) — required for SQS, where the jobs table is unused. */
export type QueueStatsSource = (topic: Topic) => Promise<QueueStats>;

export interface TopicDepth extends QueueStats {
  topic: Topic;
}

export interface QueueDepth {
  topics: TopicDepth[];
  /** Ready messages across topics. */
  depth: number;
  inFlight: number;
  dead: number;
  /** Oldest ready message across topics. */
  oldestAgeSeconds: number | null;
  /** The interactive-turn topic, which drives scale-out. */
  turn: TopicDepth;
  source: 'adapter' | 'jobs_table';
}

/**
 * Queue depth and age per topic (docs/archive/specs/10 §6 scaling signals). Uses the queue
 * adapter's stats when provided; otherwise reads the Postgres `jobs` table with
 * the same formula as PgQueue.stats (depth = queued and available now; age =
 * now − oldest ready enqueued_at).
 */
export async function queueDepth(db: DbOrTx, now: Date, source?: QueueStatsSource): Promise<QueueDepth> {
  const topics = Object.values(TOPICS);
  let rows: TopicDepth[];
  if (source) {
    rows = await Promise.all(topics.map(async (topic) => ({ topic, ...(await source(topic)) })));
  } else {
    const { rows: stats } = await db.execute<{ topic: string; depth: number; in_flight: number; dead: number; oldest: number | null }>(sql`
      SELECT topic,
             count(*) FILTER (WHERE status = 'queued' AND available_at <= ${at(now)})::int AS depth,
             count(*) FILTER (WHERE status = 'running')::int AS in_flight,
             count(*) FILTER (WHERE status = 'dead')::int AS dead,
             extract(epoch FROM ${at(now)} - min(enqueued_at) FILTER (WHERE status = 'queued' AND available_at <= ${at(now)}))::float8 AS oldest
        FROM jobs
       WHERE status IN ('queued', 'running', 'dead')
       GROUP BY topic`);
    const by = new Map(stats.map((s) => [s.topic, s]));
    rows = topics.map((topic) => {
      const s = by.get(topic);
      const oldest = num(s?.oldest);
      return { topic, depth: int(s?.depth), inFlight: int(s?.in_flight), dead: int(s?.dead), oldestAgeSeconds: oldest === null ? null : Math.max(0, Math.round(oldest)) };
    });
  }
  const ages = rows.map((r) => r.oldestAgeSeconds).filter((a): a is number => a !== null);
  return {
    topics: rows,
    depth: rows.reduce((s, r) => s + r.depth, 0),
    inFlight: rows.reduce((s, r) => s + r.inFlight, 0),
    dead: rows.reduce((s, r) => s + r.dead, 0),
    oldestAgeSeconds: ages.length ? Math.max(...ages) : null,
    turn: rows.find((r) => r.topic === TOPICS.CONVERSATION_TURN)!,
    source: source ? 'adapter' : 'jobs_table',
  };
}
