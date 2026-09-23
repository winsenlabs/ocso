import { createServer, type Server } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extendChain, verifyChain } from '../src/chain.js';
import { PostgresAuditStore } from '../src/postgres/store.js';
import { provisionPostgresAuditStore } from '../src/postgres/provision.js';
import { generateSigningKeyPem, loadSigningKey, publicKeyOf, signCheckpoint } from '../src/signing.js';
import { daysAgo, recordAt, scratchAuditDb, type ScratchAuditDb } from './support.js';

let db: ScratchAuditDb;
let store: PostgresAuditStore;
let owner: pg.Client;
const signer = loadSigningKey(generateSigningKeyPem());
const keys = [publicKeyOf(signer)];

beforeAll(async () => {
  db = await scratchAuditDb();
  store = new PostgresAuditStore({ connectionString: db.writerUrl });
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
});
afterAll(async () => {
  await store?.close();
  await owner?.end();
  await db?.drop();
});

async function rootError(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  return err instanceof Error ? err.message : 'no error';
}

/** Seals everything unsealed (what the worker's sealer does). */
async function sealAll(): Promise<number> {
  let sealed = 0;
  for (;;) {
    const records = await store.unsealed(1000);
    if (!records.length) return sealed;
    await store.appendChain(extendChain(await store.chainHead(), records));
    sealed += records.length;
  }
}

describe('postgres audit store: provisioning and privileges', () => {
  it('re-provisions idempotently (no migrations applied twice)', async () => {
    const report = await provisionPostgresAuditStore({ ownerUrl: db.ownerUrl, writerUrl: db.writerUrl, readerUrl: db.readerUrl, provisionRole: true });
    expect(report.applied).toEqual([]);
    expect(report).toMatchObject({ writer: db.role, reader: `${db.role}_r` });
  });

  it('refuses the owner as the writer in production unless explicitly allowed', async () => {
    const asOwner = new URL(db.ownerUrl);
    asOwner.username = (await owner.query<{ me: string }>('SELECT current_user AS me')).rows[0]!.me;
    const run = (allowOwnerWriter: boolean) => provisionPostgresAuditStore({ ownerUrl: db.ownerUrl, writerUrl: asOwner.toString(), provisionRole: true, production: true, allowOwnerWriter });
    expect(await rootError(run(false))).toMatch(/Refusing in production/);
    await expect(run(true)).resolves.toMatchObject({ applied: [] });
  });

  it('gives the api reader SELECT only: no insert, no purge, no settings', async () => {
    const reader = new PostgresAuditStore({ connectionString: db.readerUrl });
    try {
      expect(await reader.selfCheck()).toEqual({ canWrite: false, warnings: [] });
      expect(await store.selfCheck()).toEqual({ canWrite: true, warnings: [] });
      expect(await rootError(reader.append([recordAt(new Date())]))).toMatch(/permission denied/);
      expect(await rootError(reader.purgeBefore(daysAgo(4000)))).toMatch(/permission denied/);
      await expect(reader.chainHead()).resolves.toBeDefined();
      await expect(reader.purgeHorizon()).resolves.toBeNull();
    } finally {
      await reader.close();
    }
    const writer = new pg.Client({ connectionString: db.writerUrl });
    await writer.connect();
    try {
      expect(await rootError(writer.query('SELECT * FROM audit_store_config'))).toMatch(/permission denied/);
      expect(await rootError(writer.query('UPDATE audit_store_config SET min_retention_days = 365'))).toMatch(/permission denied/);
      expect(await rootError(writer.query(`INSERT INTO audit_purges (cutoff, partitions, records) VALUES (now(), '{}', 0)`))).toMatch(/permission denied/);
    } finally {
      await writer.end();
    }
    const ownerStore = new PostgresAuditStore({ connectionString: db.ownerUrl });
    expect((await ownerStore.selfCheck()).warnings[0]).toMatch(/owner of the audit tables/);
    await ownerStore.close();
  });

  it('gives the writer INSERT/SELECT only: UPDATE, DELETE, TRUNCATE and DDL are refused', async () => {
    const r = recordAt(new Date());
    await store.append([r]);
    const writer = new pg.Client({ connectionString: db.writerUrl });
    await writer.connect();
    try {
      expect(await rootError(writer.query(`UPDATE audit_records SET summary = 'x' WHERE id = $1`, [r.id]))).toMatch(/permission denied/);
      expect(await rootError(writer.query(`DELETE FROM audit_records WHERE id = $1`, [r.id]))).toMatch(/permission denied/);
      expect(await rootError(writer.query('TRUNCATE audit_records'))).toMatch(/permission denied/);
      expect(await rootError(writer.query('CREATE TABLE sneaky (id int)'))).toMatch(/permission denied/);
      expect(await rootError(writer.query('DELETE FROM audit_chain'))).toMatch(/permission denied/);
    } finally {
      await writer.end();
    }
  });

  it('rejects UPDATE, DELETE and TRUNCATE by trigger even for the owner', async () => {
    const r = recordAt(new Date());
    await store.append([r]);
    expect(await rootError(owner.query(`UPDATE audit_records SET summary = 'x' WHERE id = $1`, [r.id]))).toMatch(/append-only/);
    expect(await rootError(owner.query(`DELETE FROM audit_records WHERE id = $1`, [r.id]))).toMatch(/append-only/);
    expect(await rootError(owner.query('TRUNCATE audit_records'))).toMatch(/append-only/);
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    expect(await rootError(owner.query(`TRUNCATE audit_records_p${month}`))).toMatch(/append-only/);
  });
});

describe('postgres audit store: append, has, query', () => {
  it('is idempotent on id and reports what it holds', async () => {
    const r = recordAt(new Date());
    await store.append([r]);
    await store.append([r, r]);
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM audit_records WHERE id = $1', [r.id]);
    expect(rows[0].n).toBe(1);
    const missing = recordAt(new Date()).id;
    expect([...(await store.has([r.id, missing]))]).toEqual([r.id]);
  });

  it('round-trips a record exactly (payloads, team ids, millisecond time)', async () => {
    const r = recordAt(new Date('2026-09-01T10:11:12.345Z'), { teamIds: ['0199aaaa-0000-7000-8000-000000000001'], confirmation: { by: 'x' } });
    await store.append([r]);
    const [back] = await store.query({ targetId: 'a-1', since: r.occurredAt, until: new Date(r.occurredAt.getTime() + 1), limit: 5 }, null);
    expect(back).toEqual({ ...r, teamIds: [...r.teamIds] });
  });

  it('appends records years old (creates the partitions they need)', async () => {
    const old = recordAt(daysAgo(3 * 365));
    await store.append([old]);
    expect((await store.has([old.id])).has(old.id)).toBe(true);
  });

  it('filters, scopes and paginates by (occurredAt, id) descending', async () => {
    const t = new Date('2026-08-01T00:00:00.000Z');
    const teamA = '0199aaaa-0000-7000-8000-00000000000a';
    const teamB = '0199aaaa-0000-7000-8000-00000000000b';
    const rows = [
      recordAt(t, { targetType: 'scope_t', targetId: 'one', actorId: 'lead-a', teamIds: [teamA], action: 'agent.create' }),
      recordAt(t, { targetType: 'scope_t', targetId: 'two', actorId: 'lead-b', teamIds: [teamB], action: 'agent.update' }),
      recordAt(new Date(t.getTime() + 1000), { targetType: 'scope_t', targetId: 'three', actorId: 'tech', teamIds: [], action: 'queue.update' }),
      recordAt(new Date(t.getTime() + 2000), { targetType: 'queue', targetId: 'q', actorId: 'tech', teamIds: [], action: 'queue.update' }),
    ];
    await store.append(rows);
    const since = t;
    const until = new Date(t.getTime() + 10_000);
    const scoped = await store.query({ since, until, limit: 50 }, { actorId: 'lead-a', teamIds: [teamA], sharedTargetTypes: ['queue'] });
    expect(scoped.map((r) => r.targetId).sort()).toEqual(['one', 'q']);
    const byPrefix = await store.query({ since, until, actionPrefix: 'agent.', limit: 50 }, null);
    expect(byPrefix.map((r) => r.targetId).sort()).toEqual(['one', 'two']);
    const all = await store.query({ since, until, targetTypes: ['scope_t', 'queue'], limit: 50 }, null);
    expect(all.map((r) => r.targetId).slice(0, 2)).toEqual(['q', 'three']);
    const page1 = await store.query({ since, until, targetType: 'scope_t', limit: 2 }, null);
    const last = page1[page1.length - 1]!;
    const page2 = await store.query({ since, until, targetType: 'scope_t', before: { occurredAt: last.occurredAt, id: last.id }, limit: 2 }, null);
    expect([...page1, ...page2].map((r) => r.id)).toEqual([...all.filter((r) => r.targetType === 'scope_t')].map((r) => r.id));
    expect(new Set([...page1, ...page2].map((r) => r.id)).size).toBe(3);
  });
});

describe('postgres audit store: chain, checkpoints, verification', () => {
  it('seals in arrival order, refuses forks, and verifies with signed checkpoints', async () => {
    expect(await sealAll()).toBeGreaterThan(0);
    const head = (await store.chainHead())!;
    expect(await store.unsealed(10)).toEqual([]);
    // A fork (entries not continuing the head) is refused.
    const fork = extendChain({ position: head.position - 1, chainHash: head.prevHash }, [recordAt(new Date())]);
    expect(await rootError(store.appendChain(fork))).toMatch(/expected position/);
    const cp = signCheckpoint(signer, { upToPosition: head.position, chainHash: head.chainHash });
    await store.appendCheckpoint(cp);
    await store.appendCheckpoint(cp);
    expect(await store.checkpoints({ limit: 5 })).toEqual([cp]);
    const report = await verifyChain(store, { keys });
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, from: 1, to: head.position, entries: head.position, checkpoints: { checked: 1, valid: 1 } });
  });

  it('detects a record tampered with by someone who bypassed the triggers', async () => {
    const entry = (await store.chainRange(2, 1))[0]!.entry;
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable');
    await owner.query(`UPDATE audit_records SET summary = 'nothing to see here' WHERE id = $1`, [entry.recordId]);
    await owner.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable');
    await owner.query('COMMIT');
    const report = await verifyChain(store, { keys });
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual(expect.objectContaining({ kind: 'RECORD_HASH_MISMATCH', position: entry.position, recordId: entry.recordId }));
  });

  it('reports a second copy of a sealed record inserted under another time (RECORD_CONFLICT)', async () => {
    const { entry, record } = (await store.chainRange(1, 1))[0]!;
    await store.append([{ ...record!, occurredAt: new Date(record!.occurredAt.getTime() + 1), summary: 'rewritten' }]);
    const problems = (await verifyChain(store, { from: 1, to: 1, keys })).problems;
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'RECORD_CONFLICT', position: entry.position }));
  });

  it('reports a checkpoint signed by an unknown key and one whose signature does not verify', async () => {
    const head = (await store.chainHead())!;
    const other = loadSigningKey(generateSigningKeyPem());
    await store.appendCheckpoint(signCheckpoint(other, { upToPosition: head.position, chainHash: head.chainHash }));
    const forged = { ...signCheckpoint(signer, { upToPosition: head.position, chainHash: head.chainHash }), signature: signCheckpoint(signer, { upToPosition: 1, chainHash: head.chainHash }).signature };
    await store.appendCheckpoint(forged);
    const kinds = (await verifyChain(store, { from: head.position, keys })).problems.map((p) => p.kind);
    expect(kinds).toContain('CHECKPOINT_UNKNOWN_KEY');
    expect(kinds).toContain('CHECKPOINT_SIGNATURE_INVALID');
  });
});

describe('postgres audit store: purge floor, stats, health', () => {
  it('honours the owner-set minimum retention, whatever the writer asks', async () => {
    const old = recordAt(daysAgo(500));
    await store.append([old]);
    await provisionPostgresAuditStore({ ownerUrl: db.ownerUrl, writerUrl: db.writerUrl, readerUrl: db.readerUrl, provisionRole: true, minRetentionDays: 2555 });
    expect(await store.purgeBefore(new Date())).toBe(0);
    expect((await store.has([old.id])).has(old.id)).toBe(true);
    expect(await store.purgeHorizon()).toBeNull();
    await provisionPostgresAuditStore({ ownerUrl: db.ownerUrl, writerUrl: db.writerUrl, readerUrl: db.readerUrl, provisionRole: true, minRetentionDays: 365 });
  });

  it('drops only whole months older than max(cutoff, now − 365 days)', async () => {
    const ancient = recordAt(daysAgo(800));
    const recent = recordAt(daysAgo(200));
    await store.append([ancient, recent]);
    await sealAll();
    // Asking to purge everything up to now still keeps the last 365 days.
    const removed = await store.purgeBefore(new Date());
    expect(removed).toBeGreaterThanOrEqual(2); // the 800-day record and the 3-year-old one
    const held = await store.has([ancient.id, recent.id]);
    expect(held.has(ancient.id)).toBe(false);
    expect(held.has(recent.id)).toBe(true);
    // The writer can call the SECURITY DEFINER purge, but not drop a partition itself.
    const writer = new pg.Client({ connectionString: db.writerUrl });
    await writer.connect();
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    expect(await rootError(writer.query(`DROP TABLE audit_records_p${month}`))).toMatch(/must be owner|permission denied/);
    await writer.end();
    // The drop is logged: the horizon is the end of the newest dropped month.
    const horizon = (await store.purgeHorizon())!;
    expect(horizon.getTime()).toBeLessThanOrEqual(daysAgo(365).getTime());
    expect(horizon.getTime()).toBeGreaterThan(ancient.occurredAt.getTime());
    // Purged records still link in the chain; verification counts them as purged, not missing.
    const report = await verifyChain(store, { keys });
    expect(report.purged).toBeGreaterThanOrEqual(2);
    expect(report.problems.filter((p) => p.kind === 'RECORD_MISSING')).toEqual([]);
  });

  it('does not count a recent record as purged under a purge log row that breaks the floor', async () => {
    const victim = recordAt(daysAgo(30));
    await store.append([victim]);
    await sealAll();
    const { rows } = await owner.query<{ position: string }>('SELECT position FROM audit_chain WHERE record_id = $1', [victim.id]);
    const position = Number(rows[0]!.position);
    const month = `${victim.occurredAt.getUTCFullYear()}${String(victim.occurredAt.getUTCMonth() + 1).padStart(2, '0')}`;
    // Someone past the append-only triggers deletes the record and logs a "purge" of its month up to tomorrow.
    await owner.query('BEGIN');
    await owner.query('SET LOCAL session_replication_role = replica');
    await owner.query('DELETE FROM audit_records WHERE id = $1', [victim.id]);
    await owner.query('COMMIT');
    await owner.query(`INSERT INTO audit_purges (cutoff, partitions, records) VALUES (now() + interval '1 day', $1, 1)`, [[`audit_records_p${month}`]]);
    try {
      expect((await store.purgeHorizon())!.getTime()).toBeLessThanOrEqual(daysAgo(365).getTime());
      const report = await verifyChain(store, { from: position, to: position, keys });
      expect(report.purged).toBe(0);
      expect(report.problems).toEqual([expect.objectContaining({ kind: 'RECORD_MISSING', position, recordId: victim.id })]);
    } finally {
      await store.append([victim]);
    }
    expect(await verifyChain(store, { from: position, to: position, keys })).toMatchObject({ ok: true, records: 1 });
  });

  it('reports stats and health', async () => {
    const stats = await store.stats();
    expect(stats.rows).toBeGreaterThan(5);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.oldest!.getTime()).toBeLessThan(stats.newest!.getTime());
    expect(await store.health()).toMatchObject({ ok: true });
    const down = new PostgresAuditStore({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' });
    expect((await down.health()).ok).toBe(false);
    await down.close();
  });

  it('fails fast against a store that accepts connections but never answers', async () => {
    const sockets: import('node:net').Socket[] = [];
    const silent: Server = createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as { port: number }).port;
    const hung = new PostgresAuditStore({ connectionString: `postgres://nobody:x@127.0.0.1:${port}/none`, timeoutMs: 1000 });
    try {
      const started = Date.now();
      expect((await hung.health()).ok).toBe(false);
      expect(await rootError(hung.append([recordAt(new Date())]))).toMatch(/timeout/i);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await hung.close().catch(() => {});
      for (const s of sockets) s.destroy();
      silent.close();
    }
  });
});
