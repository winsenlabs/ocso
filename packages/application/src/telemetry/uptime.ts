import { sql } from 'drizzle-orm';
import { healthSamples, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { at, int, iso, ratio } from '../analytics/values.js';
import { workerFleet } from './workers.js';

export interface Uptime {
  windowDays: number;
  /** Minutes evaluated (since the first database sample, at most windowDays). */
  minutes: number;
  upMinutes: number;
  /** upMinutes / minutes; null before the first sample exists. */
  ratio: number | null;
  lastIncidentAt: string | null;
  workerSamplesAvailable: boolean;
  definition: string;
}

export const UPTIME_DEFINITION =
  "Per minute over the last 30 days (starting at the first 'database' health sample): the minute is up when the database sample is not DOWN and — from the first 'workers' sample on — the workers sample is not DOWN. A minute without a sample inherits 'up' only if an adjacent minute has an up sample (tolerates sampling jitter); longer gaps count as down because the sampler runs on the worker fleet. The current, incomplete minute is excluded. lastIncidentAt = latest down minute.";

/**
 * 30-day availability from health_samples (health_samples_component_idx).
 * The worker fleet itself has no per-minute history, so worker availability
 * comes from 'workers' samples written by recordWorkerHealthSample (schedule
 * it next to the database sampler); without them, a database sample implies a
 * live worker because the sampler runs on the worker fleet.
 */
export async function uptime(db: DbOrTx, now: Date, windowDays = 30): Promise<Uptime> {
  const { rows } = await db.execute<{ minutes: number; up_minutes: number; last_down: Date | null; has_workers: boolean }>(sql`
    WITH bounds AS (
      SELECT greatest(date_trunc('minute', min(sampled_at)), date_trunc('minute', ${at(now)} - make_interval(days => ${windowDays}))) AS start_at,
             date_trunc('minute', ${at(now)}) AS end_at
        FROM health_samples
       WHERE component = 'database' AND sampled_at > ${at(now)} - make_interval(days => ${windowDays}) AND sampled_at <= ${at(now)}
      HAVING count(*) > 0
    ),
    db_min AS (
      SELECT date_trunc('minute', sampled_at) AS m, bool_and(status <> 'DOWN') AS up
        FROM health_samples
       WHERE component = 'database' AND sampled_at > ${at(now)} - make_interval(days => ${windowDays}) AND sampled_at <= ${at(now)}
       GROUP BY 1
    ),
    wk_min AS (
      SELECT date_trunc('minute', sampled_at) AS m, bool_and(status <> 'DOWN') AS up
        FROM health_samples
       WHERE component = 'workers' AND sampled_at > ${at(now)} - make_interval(days => ${windowDays}) AND sampled_at <= ${at(now)}
       GROUP BY 1
    ),
    first_wk AS (SELECT min(m) AS m FROM wk_min),
    minutes AS (
      SELECT g.m, d.up AS db_up, w.up AS wk_up,
             lag(d.up) OVER (ORDER BY g.m) AS db_prev, lead(d.up) OVER (ORDER BY g.m) AS db_next,
             lag(w.up) OVER (ORDER BY g.m) AS wk_prev, lead(w.up) OVER (ORDER BY g.m) AS wk_next
        FROM bounds, generate_series(bounds.start_at, bounds.end_at - interval '1 minute', interval '1 minute') AS g(m)
        LEFT JOIN db_min d ON d.m = g.m
        LEFT JOIN wk_min w ON w.m = g.m
    ),
    judged AS (
      SELECT m,
             coalesce(db_up, (db_prev IS TRUE OR db_next IS TRUE) AND db_prev IS NOT FALSE AND db_next IS NOT FALSE) AS db_ok,
             coalesce(wk_up, (wk_prev IS TRUE OR wk_next IS TRUE) AND wk_prev IS NOT FALSE AND wk_next IS NOT FALSE) AS wk_ok
        FROM minutes
    )
    SELECT count(*)::int AS minutes,
           count(*) FILTER (WHERE up)::int AS up_minutes,
           max(m) FILTER (WHERE NOT up) AS last_down,
           (SELECT m FROM first_wk) IS NOT NULL AS has_workers
      FROM (
        SELECT j.m, (j.db_ok AND (f.m IS NULL OR j.m < f.m OR j.wk_ok)) AS up
          FROM judged j, first_wk f
      ) verdict`);
  const r = rows[0];
  const minutes = int(r?.minutes);
  const up = int(r?.up_minutes);
  return {
    windowDays,
    minutes,
    upMinutes: up,
    ratio: ratio(up, minutes),
    lastIncidentAt: iso(r?.last_down ?? null),
    workerSamplesAvailable: Boolean(r?.has_workers),
    definition: UPTIME_DEFINITION,
  };
}

/**
 * Write a 'workers' health sample: OK when healthy workers ≥ min warm workers,
 * DEGRADED when some but fewer, DOWN when none (or none required and none alive).
 * Intended for the worker scheduler, every 60 s (idempotent, append-only).
 */
export async function recordWorkerHealthSample(db: Db, now: Date = new Date()): Promise<'OK' | 'DEGRADED' | 'DOWN'> {
  const fleet = await workerFleet(db, now);
  const min = fleet.settings.minWarmWorkers;
  const status = fleet.healthy === 0 ? 'DOWN' : fleet.healthy < min ? 'DEGRADED' : 'OK';
  await db.insert(healthSamples).values({ id: uuidv7(), component: 'workers', status, detail: `${fleet.healthy} healthy of min ${min}`, sampledAt: now });
  return status;
}
