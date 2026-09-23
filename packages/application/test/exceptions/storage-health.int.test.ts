import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { healthSampleRollups, healthSamples, storageSamples, uuidv7 } from '@ocso/db';
import type { AuditStore } from '@ocso/audit-store';
import { RetentionService, rollupHealthSamples, sampleStorage, storageReport, uptime, AVAILABILITY_COMPONENT } from '../../src/index.js';

/** Storage samples and growth (PM/research/11 §7) and hourly health roll-ups with the two-day raw window. */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

const fakeStore = (rows: number, bytes: number | null, fail = false) =>
  ({ driver: 'postgres', stats: async () => (fail ? Promise.reject(new Error('down')) : { rows, bytes, oldest: null, newest: null }) }) as unknown as AuditStore;

describe('storage samples', () => {
  it('samples every table once per day (re-running updates that day) plus the audit store', async () => {
    const now = new Date('2026-09-23T10:00:00Z');
    const first = await sampleStorage(t.db, fakeStore(1234, 5_000_000), now);
    expect(first.auditStore).toBe('sampled');
    expect(first.tables).toBeGreaterThan(40);
    const again = await sampleStorage(t.db, fakeStore(1300, 5_100_000), new Date('2026-09-23T11:00:00Z'));
    expect(again.tables).toBe(first.tables);
    const rows = await t.db.select().from(storageSamples).where(eq(storageSamples.day, '2026-09-23'));
    expect(rows).toHaveLength(first.tables + 1);
    expect(rows.find((r) => r.tableName === 'audit_store.audit_records')).toMatchObject({ rows: 1300, bytes: 5_100_000 });
    const users = rows.find((r) => r.tableName === 'users')!;
    expect(users.rows).toBeGreaterThanOrEqual(0);
    expect(users.bytes).toBeGreaterThan(0);
  });

  it('a store that does not answer does not stop the main database sample', async () => {
    const result = await sampleStorage(t.db, fakeStore(0, 0, true), new Date('2026-09-24T10:00:00Z'));
    expect(result.auditStore).toBe('unavailable');
    expect(result.tables).toBeGreaterThan(40);
  });

  it('reports growth over 7 and 30 days, the total series and ClickHouse guidance', async () => {
    const day = (d: string) => d;
    // History for one table and the audit store: 30 days ago, 7 days ago, and the latest sample (the 24th).
    await t.db.insert(storageSamples).values([
      { day: day('2026-08-25'), tableName: 'interactions', rows: 1000, bytes: 1_000_000 },
      { day: day('2026-09-17'), tableName: 'interactions', rows: 8000, bytes: 8_000_000 },
      { day: day('2026-08-25'), tableName: 'audit_store.audit_records', rows: 1_000_000, bytes: 1e9 },
      { day: day('2026-09-24'), tableName: 'audit_store.audit_records', rows: 61_000_000, bytes: 2e9 },
    ]);
    await t.db.update(storageSamples).set({ rows: 10_000, bytes: 10_000_000 }).where(sql`${storageSamples.tableName} = 'interactions' AND ${storageSamples.day} = '2026-09-24'`);
    const report = await storageReport(t.db, { auditDriver: 'postgres' });
    expect(report.sampledDay).toBe('2026-09-24');
    const interactions = report.tables.find((r) => r.table === 'interactions')!;
    expect(interactions).toMatchObject({ rows: 10_000, bytes: 10_000_000, rows7d: 2000, bytes7d: 2_000_000, rows30d: 9000, bytes30d: 9_000_000, bytesPerDay: 300_000 });
    expect(report.tables.some((r) => r.table.startsWith('audit_store.'))).toBe(false);
    expect(report.auditStore).toMatchObject({ rows: 61_000_000, rowsPerDay: 2_000_000, sampledDay: '2026-09-24' });
    expect(report.guidance.level).toBe('recommend');
    expect(report.series.at(-1)!.day).toBe('2026-09-24');
    expect(report.database.bytes).toBe(report.series.at(-1)!.bytes);
    expect((await storageReport(t.db, { auditDriver: 'x', auditSizing: { kind: 'columnar', label: 'Columnar' } })).guidance.level).toBe('columnar');
  });
});

describe('health roll-ups', () => {
  const HOUR = 3_600_000;
  const start = new Date('2026-09-20T00:00:00Z');
  const now = new Date(start.getTime() + 72 * HOUR + 10 * 60_000); // three days of samples, ten minutes into the fourth

  beforeAll(async () => {
    await t.db.delete(healthSamples);
    const rows: Array<typeof healthSamples.$inferInsert> = [];
    for (let m = 0; m < 72 * 60 + 10; m++) {
      const at = new Date(start.getTime() + m * 60_000 + 5_000);
      // Hour 30 is an outage: the database answers DOWN for 20 minutes.
      const hour = Math.floor(m / 60);
      const down = hour === 30 && m % 60 < 20;
      rows.push({ id: uuidv7(), component: 'database', status: down ? 'DOWN' : 'OK', latencyMs: down ? 5000 : 3 + (m % 5), sampledAt: at });
      rows.push({ id: uuidv7(), component: 'workers', status: 'OK', sampledAt: at });
    }
    for (let i = 0; i < rows.length; i += 2000) await t.db.insert(healthSamples).values(rows.slice(i, i + 2000));
  });

  it('rolls complete hours up, keeps raw samples two days, and uptime is unchanged by the prune', async () => {
    const before = await uptime(t.db, now);
    const result = await rollupHealthSamples(t.db, now);
    expect(result.hours).toBe(72);
    expect(result.rawPruned).toBeGreaterThan(0);
    const oldest = (await t.db.execute<{ m: Date }>(sql`SELECT min(sampled_at) AS m FROM health_samples`)).rows[0]!.m;
    expect(new Date(oldest).getTime()).toBeGreaterThanOrEqual(now.getTime() - 48 * HOUR - HOUR);
    const outage = await t.db.select().from(healthSampleRollups).where(sql`${healthSampleRollups.hour} = ${new Date(start.getTime() + 30 * HOUR).toISOString()}::timestamptz`);
    const db = outage.find((r) => r.component === 'database')!;
    expect(db).toMatchObject({ samples: 60, down: 20, ok: 40, minutes: 60, upMinutes: 40, latencyMaxMs: 5000 });
    expect(outage.find((r) => r.component === AVAILABILITY_COMPONENT)).toMatchObject({ minutes: 60, upMinutes: 40 });
    const after = await uptime(t.db, now);
    expect(after.minutes).toBe(before.minutes);
    expect(after.upMinutes).toBe(before.upMinutes);
    expect(after.lastIncidentAt).toBe(before.lastIncidentAt);
    expect(after.workerSamplesAvailable).toBe(true);
  });

  it('is idempotent: a second run rolls nothing new and prunes nothing more', async () => {
    const again = await rollupHealthSamples(t.db, now);
    expect(again).toMatchObject({ hours: 0, rawPruned: 0 });
  });

  it('an hour with no samples at all after the first one is down, not missing', async () => {
    const later = new Date(now.getTime() + 3 * HOUR);
    const result = await rollupHealthSamples(t.db, later);
    expect(result.hours).toBe(3); // hours 72, 73 and 74 are complete; the sampler stopped at 72:10
    const [gap] = await t.db.select().from(healthSampleRollups).where(sql`${healthSampleRollups.component} = ${AVAILABILITY_COMPONENT} AND ${healthSampleRollups.hour} = ${new Date(start.getTime() + 73 * HOUR).toISOString()}::timestamptz`);
    expect(gap).toMatchObject({ minutes: 60, upMinutes: 0 });
  });
});

describe('operational retention and roll-ups', () => {
  it('retention never prunes raw health samples the roll-up has not reached, however short the window', async () => {
    const t2 = await createTestDatabase();
    try {
      await t2.pool.query(`UPDATE deployment_settings SET retention = '{"operational": 1}'::jsonb`);
      const now = new Date('2026-09-23T10:00:00Z');
      const old = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
      await t2.db.insert(healthSamples).values([
        { id: uuidv7(), component: 'database', status: 'OK', sampledAt: old(5) },
        { id: uuidv7(), component: 'database', status: 'OK', sampledAt: old(3) },
      ]);
      const retention = new RetentionService(t2.db, { delete: async () => {} });
      // The roll-up has never run: nothing is pruned.
      await retention.run(now);
      expect((await t2.db.select().from(healthSamples)).length).toBe(2);
      // Rolled up to four days ago: the older sample goes, the newer one (not yet rolled up) stays.
      await t2.db.insert(healthSampleRollups).values({ hour: new Date(old(4).getTime() - 3_600_000), component: AVAILABILITY_COMPONENT, minutes: 60, upMinutes: 60 });
      await retention.run(now);
      expect((await t2.db.select().from(healthSamples)).map((r) => r.sampledAt.toISOString())).toEqual([old(3).toISOString()]);
    } finally {
      await t2.drop();
    }
  });
});
