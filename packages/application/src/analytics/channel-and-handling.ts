import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { agentClause, at, cohortWhere, int, num, ratio, type AnalyticsWindow } from './values.js';

export interface ChannelBreakdown {
  channelId: string | null;
  kind: string | null;
  name: string | null;
  conversations: number;
  contained: number;
  containmentRate: number | null;
  csat: number | null;
  csatResponses: number;
}

export const HANDLING_BUCKETS = ['<2m', '2-10m', '10-30m', '>30m'] as const;
export type HandlingBucket = (typeof HANDLING_BUCKETS)[number];

export interface HandlingTime {
  buckets: Array<{ bucket: HandlingBucket; ai: number; human: number; total: number }>;
  aiMedianSeconds: number | null;
  humanMedianSeconds: number | null;
}

/** Volume / containment (cohort) and CSAT (responses in window) per channel. */
export async function channelBreakdown(db: DbOrTx, w: AnalyticsWindow): Promise<ChannelBreakdown[]> {
  const volume = await db.execute<{ channel_id: string | null; kind: string | null; name: string | null; n: number; contained: number }>(sql`
    SELECT c.channel_id, ch.kind, ch.name, count(*)::int AS n,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id))::int AS contained
      FROM conversations c
      LEFT JOIN channels ch ON ch.id = c.channel_id
     WHERE ${cohortWhere(w)}
     GROUP BY c.channel_id, ch.kind, ch.name
     ORDER BY n DESC`);
  const csat = await db.execute<{ channel_id: string | null; avg: number | null; n: number }>(sql`
    SELECT c.channel_id, avg(r.score)::float8 AS avg, count(*)::int AS n
      FROM csat_responses r
      JOIN conversations c ON c.id = r.conversation_id
     WHERE ${agentClause(sql`r.agent_id`, w.agentId)} AND r.received_at >= ${at(w.from)} AND r.received_at < ${at(w.to)}
     GROUP BY c.channel_id`);
  const csatBy = new Map(csat.rows.map((r) => [r.channel_id ?? 'none', r]));
  return volume.rows.map((r) => {
    const s = csatBy.get(r.channel_id ?? 'none');
    return {
      channelId: r.channel_id,
      kind: r.kind,
      name: r.name,
      conversations: int(r.n),
      contained: int(r.contained),
      containmentRate: ratio(int(r.contained), int(r.n)),
      csat: num(s?.avg),
      csatResponses: int(s?.n),
    };
  });
}

/** Handling-time distribution (definitions.handlingTime) for resolved cohort conversations. */
export async function handlingTime(db: DbOrTx, w: AnalyticsWindow): Promise<HandlingTime> {
  const { rows } = await db.execute<{ human: boolean; bucket: HandlingBucket | null; n: number; median: number | null }>(sql`
    WITH resolved AS (
      SELECT extract(epoch FROM c.resolved_at - c.opened_at)::float8 AS secs,
             EXISTS (SELECT 1 FROM handoffs h WHERE h.conversation_id = c.id) AS human
        FROM conversations c
       WHERE ${cohortWhere(w)} AND c.control_state = 'RESOLVED' AND c.resolved_at IS NOT NULL
    )
    SELECT human,
           CASE WHEN secs < 120 THEN '<2m' WHEN secs < 600 THEN '2-10m' WHEN secs < 1800 THEN '10-30m' ELSE '>30m' END AS bucket,
           count(*)::int AS n,
           NULL::float8 AS median
      FROM resolved GROUP BY human, 2
    UNION ALL
    SELECT human, NULL, count(*)::int, percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)
      FROM resolved GROUP BY human`);
  const count = (bucket: HandlingBucket, human: boolean) => int(rows.find((r) => r.bucket === bucket && r.human === human)?.n);
  const median = (human: boolean) => {
    const m = num(rows.find((r) => r.bucket === null && r.human === human)?.median);
    return m === null ? null : Math.round(m);
  };
  return {
    buckets: HANDLING_BUCKETS.map((bucket) => {
      const ai = count(bucket, false);
      const human = count(bucket, true);
      return { bucket, ai, human, total: ai + human };
    }),
    aiMedianSeconds: median(false),
    humanMedianSeconds: median(true),
  };
}
