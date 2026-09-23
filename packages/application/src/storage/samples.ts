import { sql } from 'drizzle-orm';
import { withTimeout, type AuditStore } from '@ocso/audit-store';
import { storageSamples, type Db } from '@ocso/db';

/**
 * Daily storage samples (PM/research/11 §7): every table of the main database
 * (rows and bytes including indexes and TOAST) and the audit store's records,
 * one row per (UTC day, table). Re-running on the same day overwrites that
 * day's sample with the newer figures, so the leader task may run hourly.
 */

/** Tables smaller than this get an exact row count; larger ones use the planner's estimate (reltuples). */
export const EXACT_COUNT_MAX_BYTES = 64 * 1024 * 1024;
/** Prefix of audit-store rows in storage_samples. */
export const AUDIT_STORE_PREFIX = 'audit_store.';
/** Samples are kept this long (a year of growth history, plus margin). */
export const STORAGE_SAMPLE_KEEP_DAYS = 400;

export interface StorageSampleResult {
  day: string;
  tables: number;
  auditStore: 'sampled' | 'unavailable' | 'none';
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export async function sampleStorage(db: Db, store: AuditStore | null, now: Date = new Date()): Promise<StorageSampleResult> {
  const day = utcDay(now);
  const { rows } = await db.execute<{ table_name: string; estimate: string | number; bytes: string | number }>(sql`
    SELECT c.relname AS table_name, c.reltuples::bigint AS estimate,
           CASE WHEN c.relkind = 'p'
                THEN (SELECT coalesce(sum(pg_total_relation_size(t.relid)), 0) FROM pg_partition_tree(c.oid) t)
                ELSE pg_total_relation_size(c.oid) END AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     ORDER BY c.relname`);
  const samples: Array<{ tableName: string; rows: number; bytes: number | null }> = [];
  for (const r of rows) {
    const bytes = Number(r.bytes);
    let count = Number(r.estimate);
    if (count < 0 || bytes < EXACT_COUNT_MAX_BYTES) {
      const [exact] = (await db.execute<{ n: string | number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(r.table_name)}`)).rows;
      count = Number(exact?.n ?? 0);
    }
    samples.push({ tableName: r.table_name, rows: count, bytes });
  }
  let auditStore: StorageSampleResult['auditStore'] = 'none';
  if (store) {
    try {
      const stats = await withTimeout(store.stats(), 15_000, 'the audit store');
      samples.push({ tableName: `${AUDIT_STORE_PREFIX}audit_records`, rows: stats.rows, bytes: stats.bytes });
      auditStore = 'sampled';
    } catch {
      auditStore = 'unavailable';
    }
  }
  const sampledAt = now;
  for (let i = 0; i < samples.length; i += 200) {
    await db
      .insert(storageSamples)
      .values(samples.slice(i, i + 200).map((s) => ({ day, tableName: s.tableName, rows: s.rows, bytes: s.bytes, sampledAt })))
      .onConflictDoUpdate({
        target: [storageSamples.day, storageSamples.tableName],
        set: { rows: sql`excluded.rows`, bytes: sql`excluded.bytes`, sampledAt: sql`excluded.sampled_at` },
      });
  }
  await db.delete(storageSamples).where(sql`${storageSamples.day} < ${utcDay(new Date(now.getTime() - STORAGE_SAMPLE_KEEP_DAYS * 86_400_000))}::date`);
  return { day, tables: samples.length - (auditStore === 'sampled' ? 1 : 0), auditStore };
}
