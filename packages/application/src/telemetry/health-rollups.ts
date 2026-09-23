import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@ocso/db';
import { at } from '../analytics/values.js';

/**
 * Hourly roll-ups of health_samples (PM/research/11 §7). Raw samples are kept
 * RAW_HEALTH_KEEP_HOURS; each complete hour is rolled up first — per component
 * (sample counts, minutes, latency) and one `availability` row holding the
 * per-minute uptime verdict of that hour (the rule in uptime.ts) — so 30-day
 * uptime and longer history survive the raw prune. Idempotent: an hour is
 * upserted, and raw rows are deleted only for hours already rolled up.
 */

export const RAW_HEALTH_KEEP_HOURS = 48;
export const HEALTH_ROLLUP_KEEP_DAYS = 400;
export const AVAILABILITY_COMPONENT = 'availability';
/** Hours rolled up per run (the task catches up over a few runs after a long outage). */
const MAX_HOURS_PER_RUN = 72;
/** Samples written just after an hour ends still belong to it: wait this long before rolling it up. */
const SETTLE_MS = 5 * 60_000;
const HOUR = 3_600_000;

const hourOf = (d: Date) => new Date(Math.floor(d.getTime() / HOUR) * HOUR);

async function one<T extends Record<string, unknown>>(db: DbOrTx, q: ReturnType<typeof sql>): Promise<T | undefined> {
  return (await db.execute<T>(q)).rows[0] as T | undefined;
}

/**
 * The per-minute availability verdict over [start, end): a minute is up when
 * its database sample is not DOWN and — from `firstWorker` on — its workers
 * sample is not DOWN; a minute without a sample inherits 'up' only from an up
 * neighbour (sampling jitter). Neighbours just outside the range count.
 */
export async function judgeAvailability(db: DbOrTx, start: Date, end: Date, firstWorker: Date | null): Promise<{ minutes: number; upMinutes: number; lastDown: Date | null }> {
  if (end <= start) return { minutes: 0, upMinutes: 0, lastDown: null };
  const r = await one<{ minutes: number; up_minutes: number; last_down: Date | null }>(
    db,
    sql`
    WITH db_min AS (
      SELECT date_trunc('minute', sampled_at) AS m, bool_and(status <> 'DOWN') AS up FROM health_samples
       WHERE component = 'database' AND sampled_at >= ${at(start)} - interval '1 minute' AND sampled_at < ${at(end)} + interval '1 minute' GROUP BY 1
    ),
    wk_min AS (
      SELECT date_trunc('minute', sampled_at) AS m, bool_and(status <> 'DOWN') AS up FROM health_samples
       WHERE component = 'workers' AND sampled_at >= ${at(start)} - interval '1 minute' AND sampled_at < ${at(end)} + interval '1 minute' GROUP BY 1
    ),
    minutes AS (
      SELECT g.m, d.up AS db_up, w.up AS wk_up,
             lag(d.up) OVER (ORDER BY g.m) AS db_prev, lead(d.up) OVER (ORDER BY g.m) AS db_next,
             lag(w.up) OVER (ORDER BY g.m) AS wk_prev, lead(w.up) OVER (ORDER BY g.m) AS wk_next
        FROM generate_series(${at(start)} - interval '1 minute', ${at(end)}, interval '1 minute') AS g(m)
        LEFT JOIN db_min d ON d.m = g.m LEFT JOIN wk_min w ON w.m = g.m
    ),
    judged AS (
      SELECT m,
             coalesce(db_up, (db_prev IS TRUE OR db_next IS TRUE) AND db_prev IS NOT FALSE AND db_next IS NOT FALSE) AS db_ok,
             coalesce(wk_up, (wk_prev IS TRUE OR wk_next IS TRUE) AND wk_prev IS NOT FALSE AND wk_next IS NOT FALSE) AS wk_ok
        FROM minutes
    )
    SELECT count(*)::int AS minutes, count(*) FILTER (WHERE up)::int AS up_minutes, max(m) FILTER (WHERE NOT up) AS last_down
      FROM (SELECT m, db_ok AND (${firstWorker ? at(firstWorker) : sql`NULL::timestamptz`} IS NULL OR m < ${firstWorker ? at(firstWorker) : sql`NULL::timestamptz`} OR wk_ok) AS up
              FROM judged WHERE m >= ${at(start)} AND m < ${at(end)}) v`,
  );
  return { minutes: Number(r?.minutes ?? 0), upMinutes: Number(r?.up_minutes ?? 0), lastDown: r?.last_down ? new Date(r.last_down) : null };
}

async function firstSample(db: DbOrTx, component: string): Promise<Date | null> {
  const r = await one<{ first: Date | null }>(
    db,
    sql`SELECT least((SELECT min(sampled_at) FROM health_samples WHERE component = ${component}),
                     (SELECT min(hour) FROM health_sample_rollups WHERE component = ${component})) AS first`,
  );
  return r?.first ? new Date(Math.floor(new Date(r.first).getTime() / 60_000) * 60_000) : null;
}

export interface RollupResult {
  hours: number;
  rawPruned: number;
  rollupsPruned: number;
}

/** The health-rollup leader task: roll up complete hours, then prune raw samples of rolled-up hours older than the raw window. */
export async function rollupHealthSamples(db: Db, now: Date = new Date()): Promise<RollupResult> {
  const lastRolled = await one<{ hour: Date | null }>(db, sql`SELECT max(hour) AS hour FROM health_sample_rollups WHERE component = ${AVAILABILITY_COMPONENT}`);
  const firstRaw = await one<{ first: Date | null }>(db, sql`SELECT min(sampled_at) AS first FROM health_samples`);
  let next = lastRolled?.hour ? new Date(new Date(lastRolled.hour).getTime() + HOUR) : firstRaw?.first ? hourOf(new Date(firstRaw.first)) : null;
  const firstDb = await firstSample(db, 'database');
  const firstWorker = await firstSample(db, 'workers');
  let hours = 0;
  while (next && next.getTime() + HOUR + SETTLE_MS <= now.getTime() && hours < MAX_HOURS_PER_RUN) {
    const start = next;
    const end = new Date(start.getTime() + HOUR);
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO health_sample_rollups (hour, component, samples, ok, degraded, down, minutes, up_minutes, last_down_at, latency_avg_ms, latency_p95_ms, latency_max_ms, rolled_at)
        SELECT ${at(start)}, component, count(*)::int,
               count(*) FILTER (WHERE status = 'OK')::int, count(*) FILTER (WHERE status = 'DEGRADED')::int, count(*) FILTER (WHERE status = 'DOWN')::int,
               count(DISTINCT date_trunc('minute', sampled_at))::int,
               (count(DISTINCT date_trunc('minute', sampled_at)) - count(DISTINCT date_trunc('minute', sampled_at)) FILTER (WHERE status = 'DOWN'))::int,
               max(sampled_at) FILTER (WHERE status = 'DOWN'),
               round(avg(latency_ms))::int, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int, max(latency_ms), ${at(now)}
          FROM health_samples WHERE sampled_at >= ${at(start)} AND sampled_at < ${at(end)}
         GROUP BY component
        ON CONFLICT (hour, component) DO UPDATE SET samples = excluded.samples, ok = excluded.ok, degraded = excluded.degraded, down = excluded.down,
               minutes = excluded.minutes, up_minutes = excluded.up_minutes, last_down_at = excluded.last_down_at, latency_avg_ms = excluded.latency_avg_ms,
               latency_p95_ms = excluded.latency_p95_ms, latency_max_ms = excluded.latency_max_ms, rolled_at = excluded.rolled_at`);
      // Uptime starts at the first database sample ever; after that an hour without samples is down, not missing.
      const from = firstDb && firstDb > start ? new Date(Math.floor(firstDb.getTime() / 60_000) * 60_000) : start;
      const verdict = firstDb && firstDb < end ? await judgeAvailability(tx, from, end, firstWorker) : { minutes: 0, upMinutes: 0, lastDown: null };
      await tx.execute(sql`
        INSERT INTO health_sample_rollups (hour, component, minutes, up_minutes, last_down_at, rolled_at)
        VALUES (${at(start)}, ${AVAILABILITY_COMPONENT}, ${verdict.minutes}, ${verdict.upMinutes}, ${verdict.lastDown ? at(verdict.lastDown) : sql`NULL`}, ${at(now)})
        ON CONFLICT (hour, component) DO UPDATE SET minutes = excluded.minutes, up_minutes = excluded.up_minutes, last_down_at = excluded.last_down_at, rolled_at = excluded.rolled_at`);
    });
    hours++;
    next = new Date(start.getTime() + HOUR);
  }
  // Raw samples older than the raw window go, but only for hours that have been rolled up.
  const rolledThrough = await one<{ hour: Date | null }>(db, sql`SELECT max(hour) AS hour FROM health_sample_rollups WHERE component = ${AVAILABILITY_COMPONENT}`);
  let rawPruned = 0;
  if (rolledThrough?.hour) {
    // Whole hours only, so the raw window starts on an hour boundary and uptime joins roll-ups to raw minutes without a gap.
    const cutoff = hourOf(new Date(Math.min(now.getTime() - RAW_HEALTH_KEEP_HOURS * HOUR, new Date(rolledThrough.hour).getTime() + HOUR)));
    for (let i = 0; i < 20; i++) {
      const { rowCount } = await db.execute(sql`DELETE FROM health_samples WHERE id IN (SELECT id FROM health_samples WHERE sampled_at < ${at(cutoff)} LIMIT 10000)`);
      rawPruned += rowCount ?? 0;
      if ((rowCount ?? 0) < 10_000) break;
    }
  }
  const pruned = await db.execute(sql`DELETE FROM health_sample_rollups WHERE hour < ${at(new Date(now.getTime() - HEALTH_ROLLUP_KEEP_DAYS * 86_400_000))}`);
  return { hours, rawPruned, rollupsPruned: pruned.rowCount ?? 0 };
}
