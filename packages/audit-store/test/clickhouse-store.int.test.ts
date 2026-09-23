import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extendChain, verifyChain } from '../src/chain.js';
import { chDateTime, ClickHouseHttp } from '../src/clickhouse/http.js';
import { provisionClickHouseAuditStore } from '../src/clickhouse/provision.js';
import { json } from '../src/clickhouse/rows.js';
import { ClickHouseAuditStore } from '../src/clickhouse/store.js';
import { utcMonthKey, type AuditRecord } from '../src/contract.js';
import { generateSigningKeyPem, loadSigningKey, publicKeyOf, signCheckpoint } from '../src/signing.js';
import { daysAgo, recordAt } from './support.js';

/**
 * The clickhouse driver against a real server. Gated: set CLICKHOUSE_TEST_URL
 * to an admin connection, e.g.
 *   docker run -d --rm -p 8123:8123 -e CLICKHOUSE_USER=admin -e CLICKHOUSE_PASSWORD=adminpw \
 *     -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 clickhouse/clickhouse-server
 *   CLICKHOUSE_TEST_URL=http://admin:adminpw@localhost:8123 pnpm test:int
 * Each run provisions its own database and writer user and drops both.
 */
const raw = process.env['CLICKHOUSE_TEST_URL'];
const suite = raw ? describe : describe.skip;

const suffix = randomBytes(4).toString('hex');
const database = `ocso_audit_test_${suffix}`;
const writerUser = `ocso_audit_w_${suffix}`;
const writerPassword = randomBytes(12).toString('hex');
const purgeUser = `ocso_audit_p_${suffix}`;
const purgePassword = randomBytes(12).toString('hex');
const readerUser = `ocso_audit_r_${suffix}`;
const readerPassword = randomBytes(12).toString('hex');
let admin: ClickHouseHttp;
let store: ClickHouseAuditStore;
let writer: ClickHouseHttp;
const signer = loadSigningKey(generateSigningKeyPem());
const keys = [publicKeyOf(signer)];

function endpoint() {
  const u = new URL(raw!);
  const creds = { user: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  u.username = '';
  u.password = '';
  return { url: u.toString(), ...creds };
}

/** A record row as the driver writes it, with an explicit arrival time. */
const rawRow = (r: AuditRecord, ingestedAt: Date) => ({
  id: r.id, occurred_at: chDateTime(r.occurredAt), actor_type: r.actorType, actor_id: r.actorId, actor_name: r.actorName, via: r.via, action: r.action,
  target_type: r.targetType, target_id: r.targetId, summary: r.summary, before: json(r.before), after: json(r.after), correlation_id: r.correlationId,
  confirmation: json(r.confirmation), ip: r.ip, team_ids: [...r.teamIds], ingested_at: chDateTime(ingestedAt),
});

const positionOf = async (id: string) => Number((await admin.query<{ p: number | string }>('SELECT position AS p FROM audit_chain WHERE record_id = {id:UUID}', { id }))[0]!.p);

async function sealAll(): Promise<void> {
  for (;;) {
    const records = await store.unsealed(1000);
    if (!records.length) return;
    await store.appendChain(extendChain(await store.chainHead(), records));
  }
}

suite('clickhouse audit store (CLICKHOUSE_TEST_URL)', () => {
  beforeAll(async () => {
    const { url, user, password } = endpoint();
    const provision = () =>
      provisionClickHouseAuditStore({ url, database, adminUser: user, adminPassword: password, writerUser, writerPassword, purgeUser, purgePassword, readerUser, readerPassword, provisionRole: true, fetch });
    expect((await provision()).applied).toEqual(['0001_audit_store.sql']);
    expect((await provision()).applied).toEqual([]);
    admin = new ClickHouseHttp({ url, database, user, password, fetch });
    writer = new ClickHouseHttp({ url, database, user: writerUser, password: writerPassword, fetch });
    store = new ClickHouseAuditStore(writer, new ClickHouseHttp({ url, database, user: purgeUser, password: purgePassword, fetch }));
  });
  afterAll(async () => {
    if (!admin) return;
    await admin.exec(`DROP DATABASE IF EXISTS ${database}`, { database: null });
    await admin.exec(`DROP USER IF EXISTS ${writerUser}`, { database: null });
    await admin.exec(`DROP USER IF EXISTS ${purgeUser}`, { database: null });
    await admin.exec(`DROP USER IF EXISTS ${readerUser}`, { database: null });
  });

  it('gives the api reader SELECT only', async () => {
    const reader = new ClickHouseAuditStore(new ClickHouseHttp({ url: endpoint().url, database, user: readerUser, password: readerPassword, fetch }));
    expect(await reader.selfCheck()).toEqual({ canWrite: false, warnings: [] });
    expect(await store.selfCheck()).toMatchObject({ canWrite: true, warnings: [] });
    await expect(reader.append([recordAt(new Date())])).rejects.toMatchObject({ code: '497' });
    await expect(reader.purgeHorizon()).resolves.toBeNull();
    await expect(writer.exec(`INSERT INTO audit_purges (cutoff, partitions, records) VALUES (now(), [], 0)`)).rejects.toMatchObject({ code: '497' });
  });

  it('gives the writer SELECT/INSERT only: no UPDATE, DELETE, TRUNCATE, partition or table drops', async () => {
    await store.append([recordAt(new Date())]);
    const refused = async (sql: string) => expect(writer.exec(sql)).rejects.toMatchObject({ name: 'ClickHouseError', code: '497' });
    await refused(`ALTER TABLE audit_records UPDATE summary = 'x' WHERE 1`);
    await refused(`ALTER TABLE audit_records DELETE WHERE 1`);
    await refused(`DELETE FROM audit_records WHERE 1`);
    await refused('TRUNCATE TABLE audit_records');
    await refused('DROP TABLE audit_chain');
    await refused(`ALTER TABLE audit_chain DELETE WHERE 1`);
    await refused(`ALTER TABLE audit_records DROP PARTITION 202001`);
    // The purge user can drop record partitions, and touch nothing else.
    const purger = new ClickHouseHttp({ url: endpoint().url, database, user: purgeUser, password: purgePassword, fetch });
    await expect(purger.exec(`INSERT INTO audit_chain (position) VALUES (999999)`)).rejects.toMatchObject({ code: '497' });
    await expect(purger.exec(`ALTER TABLE audit_chain DELETE WHERE 1`)).rejects.toMatchObject({ code: '497' });
    await expect(new ClickHouseAuditStore(writer).purgeBefore(new Date())).rejects.toThrow(/CLICKHOUSE_PURGE_USER/);
  });

  it('appends idempotently and round-trips a record exactly', async () => {
    const r = recordAt(new Date('2026-09-01T10:11:12.345Z'), { teamIds: ['0199aaaa-0000-7000-8000-000000000001'], confirmation: { ok: true }, targetId: 'ch-roundtrip' });
    await store.append([r]);
    await store.append([r, r]);
    const back = await store.query({ targetId: 'ch-roundtrip', limit: 10 }, null);
    expect(back).toEqual([r]);
    expect([...(await store.has([r.id, recordAt(new Date()).id]))]).toEqual([r.id]);
  });

  it('scopes, filters and paginates like the postgres driver', async () => {
    const t = new Date('2026-08-01T00:00:00.000Z');
    const teamA = '0199aaaa-0000-7000-8000-00000000000a';
    const rows = [
      recordAt(t, { targetType: 'ch_scope', targetId: 'one', actorId: 'lead-a', teamIds: [teamA] }),
      recordAt(t, { targetType: 'ch_scope', targetId: 'two', actorId: 'lead-b', teamIds: [] }),
      recordAt(new Date(t.getTime() + 1000), { targetType: 'ch_scope', targetId: 'three', actorId: 'tech', teamIds: [] }),
      recordAt(new Date(t.getTime() + 2000), { targetType: 'queue', targetId: 'q', actorId: 'tech', teamIds: [], action: 'queue.update' }),
    ];
    await store.append(rows);
    const window = { since: t, until: new Date(t.getTime() + 10_000) };
    const scoped = await store.query({ ...window, limit: 50 }, { actorId: 'lead-a', teamIds: [teamA], sharedTargetTypes: ['queue'] });
    expect(scoped.map((r) => r.targetId).sort()).toEqual(['one', 'q']);
    expect((await store.query({ ...window, actionPrefix: 'queue.', limit: 50 }, null)).map((r) => r.targetId)).toEqual(['q']);
    const all = await store.query({ ...window, targetType: 'ch_scope', limit: 50 }, null);
    const page1 = await store.query({ ...window, targetType: 'ch_scope', limit: 2 }, null);
    const last = page1.at(-1)!;
    const page2 = await store.query({ ...window, targetType: 'ch_scope', before: { occurredAt: last.occurredAt, id: last.id }, limit: 2 }, null);
    expect([...page1, ...page2].map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(all).toHaveLength(3);
  });

  it('seals, refuses a fork, signs checkpoints, and verification catches an edited record', async () => {
    await sealAll();
    const head = (await store.chainHead())!;
    expect(head.position).toBeGreaterThan(3);
    expect(await store.unsealed(10)).toEqual([]);
    await expect(store.appendChain(extendChain({ position: head.position - 1, chainHash: head.prevHash }, [recordAt(new Date())]))).rejects.toThrow(/expected position/);
    const cp = signCheckpoint(signer, { upToPosition: head.position, chainHash: head.chainHash });
    await store.appendCheckpoint(cp);
    await store.appendCheckpoint(cp);
    expect(await store.checkpoints({ limit: 5 })).toEqual([cp]);
    expect(await verifyChain(store, { keys })).toMatchObject({ ok: true, entries: head.position, checkpoints: { valid: 1 } });
    // Someone with admin rights rewrites history; the chain does not agree.
    const victim = head.recordId;
    await admin.exec(`ALTER TABLE audit_records UPDATE summary = 'edited' WHERE id = {id:UUID}`, { params: { id: victim }, settings: { mutations_sync: 2 } });
    const report = await verifyChain(store, { keys });
    expect(report.problems).toContainEqual(expect.objectContaining({ kind: 'RECORD_HASH_MISMATCH', recordId: victim }));
  });

  it('lets only one of two overlapping sealers write a position (no fork), and verify reports an injected one', async () => {
    await sealAll();
    const head = (await store.chainHead())!;
    const a = extendChain(head, [recordAt(new Date(), { targetId: 'race-a' })]);
    const b = extendChain(head, [recordAt(new Date(), { targetId: 'race-b' })]);
    const results = await Promise.allSettled([store.appendChain(a), store.appendChain(b)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    const rows = await admin.query<{ n: number | string }>('SELECT uniqExact(chain_hash) AS n FROM audit_chain WHERE position = {p:UInt64}', { p: head.position + 1 });
    expect(Number(rows[0]!.n)).toBeLessThanOrEqual(1);
    const clean = await verifyChain(store, { from: head.position, keys });
    expect(clean.problems.filter((p) => p.kind === 'CHAIN_FORK')).toEqual([]);
    // An admin bypassing the sealer inserts a second row at an existing position.
    await admin.insert('audit_chain', [{ position: head.position, record_id: head.recordId, record_occurred_at: '2026-01-01 00:00:00.000', record_hash: 'a'.repeat(64), prev_hash: head.prevHash, chain_hash: 'b'.repeat(64), sealed_at: '2026-01-01 00:00:00.000' }]);
    expect((await verifyChain(store, { from: head.position, to: head.position, keys })).problems).toContainEqual(expect.objectContaining({ kind: 'CHAIN_FORK', position: head.position }));
  });

  it('keeps the first copy of a record and reports a rewritten second copy (RECORD_CONFLICT)', async () => {
    await sealAll();
    const { entry, record } = (await store.chainRange(1, 1))[0]!;
    await store.append([{ ...record!, summary: 'rewritten by a later insert' }]);
    expect((await store.query({ targetId: record!.targetId!, since: record!.occurredAt, until: new Date(record!.occurredAt.getTime() + 1), limit: 5 }, null))[0]!.summary).toBe(record!.summary);
    expect((await verifyChain(store, { from: 1, to: 1, keys })).problems).toContainEqual(expect.objectContaining({ kind: 'RECORD_CONFLICT', position: entry.position }));
  });

  it('purges whole months only beyond the 365-day floor, and logs it', async () => {
    const ancient = recordAt(daysAgo(800));
    const recent = recordAt(daysAgo(200));
    await store.append([ancient, recent]);
    expect(await store.purgeBefore(new Date())).toBeGreaterThanOrEqual(1);
    const held = await store.has([ancient.id, recent.id]);
    expect(held.has(ancient.id)).toBe(false);
    expect(held.has(recent.id)).toBe(true);
    expect((await store.purgeHorizon())!.getTime()).toBeGreaterThan(ancient.occurredAt.getTime());
  });

  it('logs a purge before dropping: a failed drop leaves the records verifiable, and a re-run completes it', async () => {
    const old = recordAt(daysAgo(900));
    await store.append([old]);
    await sealAll();
    const position = await positionOf(old.id);
    const purgeHttp = new ClickHouseHttp({ url: endpoint().url, database, user: purgeUser, password: purgePassword, fetch });
    const failingDrops = new Proxy(purgeHttp, {
      get(target, prop, receiver) {
        if (prop === 'exec') return async (sql: string, options?: Parameters<ClickHouseHttp['exec']>[1]) => { if (/DROP PARTITION/.test(sql)) throw new Error('connection reset'); return target.exec(sql, options); };
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await expect(new ClickHouseAuditStore(writer, failingDrops).purgeBefore(new Date())).rejects.toThrow(/connection reset/);
    expect((await store.has([old.id])).has(old.id)).toBe(true);
    expect((await store.purges()).some((p) => p.months.includes(utcMonthKey(old.occurredAt)))).toBe(true);
    expect(await verifyChain(store, { from: position, to: position, keys })).toMatchObject({ ok: true, records: 1, purged: 0 });
    // The next run finds the partition still there and drops it; the record now counts as purged.
    expect(await store.purgeBefore(new Date())).toBeGreaterThanOrEqual(1);
    expect((await store.has([old.id])).has(old.id)).toBe(false);
    expect(await verifyChain(store, { from: position, to: position, keys })).toMatchObject({ ok: true, records: 0, purged: 1 });
  });

  it('does not count a recent record as purged under a purge log row that breaks the floor', async () => {
    const victim = recordAt(daysAgo(30));
    await store.append([victim]);
    await sealAll();
    const position = await positionOf(victim.id);
    // The purge user (ALTER DELETE + INSERT on audit_purges) deletes a recent record and logs a "purge" of its month up to tomorrow.
    const purger = new ClickHouseHttp({ url: endpoint().url, database, user: purgeUser, password: purgePassword, fetch });
    await purger.exec('ALTER TABLE audit_records DELETE WHERE id = {id:UUID}', { params: { id: victim.id }, settings: { mutations_sync: 2 } });
    await purger.insert('audit_purges', [{ cutoff: chDateTime(new Date(Date.now() + 24 * 3600 * 1000)), partitions: [utcMonthKey(victim.occurredAt)], records: 1 }]);
    expect((await store.purgeHorizon())!.getTime()).toBeLessThanOrEqual(daysAgo(365).getTime());
    const report = await verifyChain(store, { from: position, to: position, keys });
    expect(report.purged).toBe(0);
    expect(report.problems).toEqual([expect.objectContaining({ kind: 'RECORD_MISSING', position, recordId: victim.id })]);
    await store.append([victim]);
  });

  it('reports stats and health', async () => {
    const stats = await store.stats();
    expect(stats.rows).toBeGreaterThan(3);
    expect(stats.oldest!.getTime()).toBeLessThan(stats.newest!.getTime());
    expect(await store.health()).toMatchObject({ ok: true });
    const wrong = new ClickHouseAuditStore(new ClickHouseHttp({ url: endpoint().url, database, user: writerUser, password: 'wrong', fetch }));
    expect((await wrong.health()).ok).toBe(false);
  });

  // Last: it writes arrival times in the future, which moves the unsealed window for anything after it.
  it('keeps unsealed records in the window when a sealed record is re-shipped later', async () => {
    await sealAll();
    const hour = 3600 * 1000;
    const base = Date.now();
    const sealed = recordAt(new Date(), { targetId: 'window-a' });
    const pending = recordAt(new Date(), { targetId: 'window-b' });
    await admin.insert('audit_records', [rawRow(sealed, new Date(base + 1.5 * hour)), rawRow(pending, new Date(base + 2 * hour))]);
    // The sealer got through the first record only (a small batch, then failures).
    const [first] = await store.unsealed(1);
    expect(first!.id).toBe(sealed.id);
    await store.appendChain(extendChain(await store.chainHead(), [first!]));
    // The shipper re-sends the sealed record much later (its shipped_at update was lost).
    await admin.insert('audit_records', [rawRow(sealed, new Date(base + 5 * hour))]);
    expect((await store.unsealed(10)).map((r) => r.id)).toEqual([pending.id]);
  });
});
