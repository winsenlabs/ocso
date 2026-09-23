import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { auditStoreGuidance, type AuditStoreGuidance } from './guidance.js';
import { AUDIT_STORE_PREFIX } from './samples.js';

/**
 * GET /v1/system/storage (PM/research/11 §7): the latest daily sample per
 * table with its growth over 7 and 30 days, the main database's total over
 * time, the audit store, and the ClickHouse guidance. Growth compares with the
 * nearest sample on or before the earlier day, so a missed day does not break it.
 */

export interface TableGrowth {
  table: string;
  rows: number;
  bytes: number | null;
  /** Change since the sample 7 / 30 days earlier; null without one. */
  rows7d: number | null;
  bytes7d: number | null;
  rows30d: number | null;
  bytes30d: number | null;
  /** Average bytes added per day over the longest window available (≤ 30 days). */
  bytesPerDay: number | null;
}

export interface StorageReport {
  sampledDay: string | null;
  sampledAt: string | null;
  database: { bytes: number; tables: number; bytes7d: number | null; bytes30d: number | null; bytesPerDay: number | null };
  /** Main-database total per day (last 90 days of samples). */
  series: Array<{ day: string; bytes: number }>;
  tables: TableGrowth[];
  auditStore: { driver: string; rows: number | null; bytes: number | null; rowsPerDay: number | null; bytesPerDay: number | null; sampledDay: string | null };
  guidance: AuditStoreGuidance;
}

interface SampleRow extends Record<string, unknown> {
  table_name: string;
  day: string;
  rows: string | number;
  bytes: string | number | null;
  rows_7: string | number | null;
  bytes_7: string | number | null;
  day_7: string | null;
  rows_30: string | number | null;
  bytes_30: string | number | null;
  day_30: string | null;
  sampled_at: Date;
}

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const daysBetween = (a: string, b: string) => Math.max(1, Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

function growth(r: SampleRow): TableGrowth {
  const rows = Number(r.rows);
  const bytes = num(r.bytes);
  const base = r.day_30 ?? r.day_7;
  const baseBytes = r.day_30 ? num(r.bytes_30) : num(r.bytes_7);
  return {
    table: r.table_name,
    rows,
    bytes,
    rows7d: diff(rows, num(r.rows_7)),
    bytes7d: diff(bytes, num(r.bytes_7)),
    rows30d: diff(rows, num(r.rows_30)),
    bytes30d: diff(bytes, num(r.bytes_30)),
    bytesPerDay: base && bytes !== null && baseBytes !== null ? Math.round((bytes - baseBytes) / daysBetween(r.day, base)) : null,
  };
}

export async function storageReport(db: DbOrTx, options: { auditDriver: string; auditSizing?: { kind: 'row' | 'columnar'; label: string } | null | undefined }): Promise<StorageReport> {
  // Latest sample per table, joined to the nearest sample at least 7 and 30 days older.
  const { rows } = await db.execute<SampleRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (table_name) table_name, day, rows, bytes, sampled_at FROM storage_samples ORDER BY table_name, day DESC
    )
    SELECT l.table_name, l.day::text AS day, l.rows, l.bytes, l.sampled_at,
           w.rows AS rows_7, w.bytes AS bytes_7, w.day::text AS day_7,
           m.rows AS rows_30, m.bytes AS bytes_30, m.day::text AS day_30
      FROM latest l
      LEFT JOIN LATERAL (SELECT rows, bytes, day FROM storage_samples s WHERE s.table_name = l.table_name AND s.day <= l.day - 7 ORDER BY s.day DESC LIMIT 1) w ON true
      LEFT JOIN LATERAL (SELECT rows, bytes, day FROM storage_samples s WHERE s.table_name = l.table_name AND s.day <= l.day - 30 ORDER BY s.day DESC LIMIT 1) m ON true
     ORDER BY l.bytes DESC NULLS LAST, l.table_name`);
  const main = rows.filter((r) => !r.table_name.startsWith(AUDIT_STORE_PREFIX));
  const audit = rows.find((r) => r.table_name === `${AUDIT_STORE_PREFIX}audit_records`) ?? null;
  const tables = main.map(growth);
  const series = (
    await db.execute<{ day: string; bytes: string | number }>(sql`
      SELECT day::text AS day, sum(coalesce(bytes, 0)) AS bytes FROM storage_samples
       WHERE table_name NOT LIKE ${`${AUDIT_STORE_PREFIX}%`} AND day > (SELECT max(day) FROM storage_samples) - 90
       GROUP BY day ORDER BY day`)
  ).rows.map((r) => ({ day: r.day, bytes: Number(r.bytes) }));
  const total = series.at(-1)?.bytes ?? 0;
  const at = (daysBack: number) => {
    const last = series.at(-1);
    if (!last) return null;
    const cutoff = Date.parse(last.day) - daysBack * 86_400_000;
    return [...series].reverse().find((p) => Date.parse(p.day) <= cutoff) ?? null;
  };
  const w7 = at(7);
  const w30 = at(30);
  const baseline = w30 ?? w7;
  const last = series.at(-1);
  const auditGrowth = audit ? growth(audit) : null;
  const auditDays = audit ? (audit.day_30 ? daysBetween(audit.day, audit.day_30) : audit.day_7 ? daysBetween(audit.day, audit.day_7) : null) : null;
  const auditRowsDelta = audit ? (audit.day_30 ? auditGrowth!.rows30d : auditGrowth!.rows7d) : null;
  const rowsPerDay = auditDays && auditRowsDelta !== null ? Math.round(auditRowsDelta / auditDays) : null;
  const auditStore = {
    driver: options.auditDriver,
    rows: audit ? Number(audit.rows) : null,
    bytes: audit ? num(audit.bytes) : null,
    rowsPerDay,
    bytesPerDay: auditGrowth?.bytesPerDay ?? null,
    sampledDay: audit?.day ?? null,
  };
  const latestAt = rows.reduce<Date | null>((m, r) => (!m || new Date(r.sampled_at) > m ? new Date(r.sampled_at) : m), null);
  return {
    sampledDay: last?.day ?? null,
    sampledAt: latestAt?.toISOString() ?? null,
    database: {
      bytes: total,
      tables: tables.length,
      bytes7d: w7 ? total - w7.bytes : null,
      bytes30d: w30 ? total - w30.bytes : null,
      bytesPerDay: baseline && last ? Math.round((total - baseline.bytes) / daysBetween(last.day, baseline.day)) : null,
    },
    series,
    tables,
    auditStore,
    guidance: auditStoreGuidance({ driver: options.auditDriver, sizing: options.auditSizing ?? null, rows: auditStore.rows, bytes: auditStore.bytes, rowsPerDay, bytesPerDay: auditStore.bytesPerDay }),
  };
}
