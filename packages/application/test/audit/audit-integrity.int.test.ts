import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PostgresAuditStore, generateSigningKeyPem, loadSigningKey, signCheckpoint } from '@ocso/audit-store';
import type { Principal } from '@ocso/auth';
import { auditEvents, auditIncidents, auditVerifications, createDatabase, users, uuidv7 } from '@ocso/db';
import { createTestAuditDatabase, createTestDatabase, type TestAuditDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  AuditExporter,
  AuditFullVerifier,
  AuditSealer,
  AuditShipper,
  RetentionService,
  acknowledgeChainBreak,
  auditStoreStatus,
  readAudit,
  reconcileAudit,
  recordAudit,
  recordAuditIncident,
  type ActorContext,
} from '../../src/index.js';
import { FlakyStore, backdateAudit } from './support.js';

/** The review fixes of ADR-032: incidents that survive restarts, hangs, bounded sealing past a break, fencing, restores. */
let t: TestDatabase;
let a: TestAuditDatabase;
let store: FlakyStore;
const signer = loadSigningKey(generateSigningKeyPem());
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tia', teamIds: [], via: 'UI' };
const as = (principal: Principal): ActorContext => ({ principal, correlationId: 'integrity-test' });
const write = (action: string) => t.db.transaction((tx) => recordAudit(tx, as(tech), { action, targetType: 'thing', targetId: uuidv7(), summary: action }));
const open = (kind: string) => t.db.select().from(auditIncidents).where(and(eq(auditIncidents.kind, kind as 'CHAIN_BROKEN'), isNull(auditIncidents.resolvedAt)));
const shipAndSeal = async (options: ConstructorParameters<typeof AuditSealer>[3] = {}) => {
  await new AuditShipper(t.db, store).ship();
  return new AuditSealer(t.db, store, signer, options).seal();
};

beforeAll(async () => {
  t = await createTestDatabase();
  a = await createTestAuditDatabase();
  store = new FlakyStore(new PostgresAuditStore({ connectionString: a.url }));
  await t.db.insert(users).values({ id: tech.userId, email: 'tia@x.test', name: 'Tia', role: 'TECH' });
});
afterAll(async () => {
  await store?.close();
  await t?.drop();
  await a?.drop();
});

describe('incidents survive restarts and leader changes', () => {
  it('a fresh shipper (restart, another worker) resolves STORE_DOWN once shipping works', async () => {
    await recordAuditIncident(t.db, 'STORE_DOWN', { driver: 'flaky', error: 'opened by another worker' });
    await recordAuditIncident(t.db, 'SHIP_FAILED', { driver: 'flaky', error: 'opened by another worker' });
    await write('restart.one');
    expect((await new AuditShipper(t.db, store).ship()).shipped).toBe(1);
    expect(await open('STORE_DOWN')).toEqual([]);
    expect(await open('SHIP_FAILED')).toEqual([]);
  });

  it('a reconcile that reaches the store resolves STORE_DOWN too', async () => {
    await recordAuditIncident(t.db, 'STORE_DOWN', { driver: 'flaky', during: 'reconcile' });
    await write('restart.two');
    await new AuditShipper(t.db, store, { now: () => Date.now() }).ship();
    await recordAuditIncident(t.db, 'STORE_DOWN', { driver: 'flaky', during: 'reconcile' });
    expect((await reconcileAudit(t.db, store, { graceSeconds: -1 })).verified).toBeGreaterThan(0);
    expect(await open('STORE_DOWN')).toEqual([]);
  });
});

describe('a store that hangs', () => {
  it('the audit read answers from the local window within the timeout', async () => {
    const id = await write('hang.read');
    store.hang = true;
    const started = Date.now();
    const errors: unknown[] = [];
    const { rows, source } = await readAudit(store, t.db, { limit: 50, action: 'hang.' }, null, (e) => errors.push(e), 300);
    store.hang = false;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(source).toBe('local');
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect((errors[0] as { code?: string }).code).toBe('AUDIT_STORE_TIMEOUT');
  });

  it('merges rows shipped but not yet verified (an append the store lost stays visible)', async () => {
    const lost = await write('lost.append');
    store.drop.add(lost);
    await new AuditShipper(t.db, store).ship();
    store.drop.clear();
    const { rows, source } = await readAudit(store, t.db, { limit: 50, action: 'lost.' }, null);
    expect(source).toBe('store');
    expect(rows.map((r) => r.id)).toEqual([lost]);
    await reconcileAudit(t.db, store, { graceSeconds: -1 });
    await new AuditShipper(t.db, store).ship();
  });
});

describe('audit-seal: fenced, bounded, and it keeps signing past a known break', () => {
  it('checkpoints a long unsigned range in bounded steps', async () => {
    for (let i = 0; i < 6; i++) await write(`bounded.${i}`);
    const first = await shipAndSeal({ maxVerifyEntries: 3 });
    expect(first.checkpoint!.upToPosition).toBeLessThan(first.head!);
    let result = first;
    for (let i = 0; i < 10 && result.checkpoint && result.checkpoint.upToPosition < result.head!; i++) result = await new AuditSealer(t.db, store, signer, { maxVerifyEntries: 3, checkpointEvery: 1 }).seal();
    expect((await store.checkpoints({ limit: 1 }))[0]!.upToPosition).toBe(result.head);
  });

  it('skips while another sealer holds the lock (an overlapping leader)', async () => {
    const holder = createDatabase({ connectionString: t.url, maxConnections: 1 });
    await holder.pool.query('BEGIN');
    await holder.pool.query(`SELECT pg_advisory_xact_lock(hashtext('ocso:audit-seal'))`);
    await write('fenced.one');
    await new AuditShipper(t.db, store).ship();
    expect(await new AuditSealer(t.db, store, signer).seal()).toMatchObject({ skipped: true, sealed: 0 });
    await holder.pool.query('ROLLBACK');
    await holder.close();
    expect((await new AuditSealer(t.db, store, signer).seal()).sealed).toBe(1);
  });

  it('records where a break is, keeps checkpointing later ranges, and an acknowledgement closes it (audited)', async () => {
    const victim = await write('break.victim');
    await shipAndSeal({ checkpointEvery: 1 });
    const owner = createDatabase({ connectionString: a.ownerUrl, maxConnections: 1 });
    await owner.pool.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable');
    await owner.pool.query(`UPDATE audit_records SET summary = 'edited' WHERE id = $1`, [victim]);
    await owner.pool.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable');
    await owner.close();
    // The break sits at the last checkpoint: the next check (after new entries) finds it.
    await write('break.after-1');
    const broken = await shipAndSeal({ checkpointEvery: 1 });
    expect(broken).toMatchObject({ broken: true, checkpoint: null });
    const [incident] = await open('CHAIN_BROKEN');
    const position = (await store.chainRange(1, 10_000)).find((i) => i.entry.recordId === victim)!.entry.position;
    expect(incident!.detail).toMatchObject({ firstBrokenAt: position, lastBrokenAt: position, checkedTo: broken.head });
    // Later entries verify on their own: signed again, the incident is not bumped, its checkedTo moves on.
    await write('break.after-2');
    const later = await shipAndSeal({ checkpointEvery: 1 });
    expect(later.checkpoint).toMatchObject({ upToPosition: later.head });
    const [still] = await open('CHAIN_BROKEN');
    expect(still).toMatchObject({ count: incident!.count, detail: expect.objectContaining({ checkedTo: later.head }) });
    // Exports continue past the break.
    const blobs = new Map<string, Uint8Array>();
    expect(await new AuditExporter(t.db, store, { put: async ({ key, data }) => void blobs.set(key, data) }, signer).exportDue()).toMatchObject({ toPosition: later.head });

    const acknowledged = await acknowledgeChainBreak(t.db, as(tech), still!.id, 'Restored from the ticket OPS-42; the edit was a DBA test.');
    expect(acknowledged.resolvedAt).not.toBeNull();
    expect(acknowledged.detail).toMatchObject({ acknowledged: { by: tech.userId, note: expect.stringMatching(/OPS-42/) } });
    const [event] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'audit.chain_acknowledge'));
    expect(event).toMatchObject({ targetType: 'audit_store', targetId: still!.id });
    await expect(acknowledgeChainBreak(t.db, as(tech), still!.id, 'twice is not allowed')).rejects.toThrow(/not found/i);

    // The daily full verification walks the whole chain in pages and reports the acknowledged range as known.
    const verifier = new AuditFullVerifier(t.db, store, signer, { pageEntries: 4 });
    let run = await verifier.run();
    for (let i = 0; i < 20 && run && !run.finishedAt; i++) run = await verifier.run();
    expect(run).toMatchObject({ ok: true, finishedAt: expect.any(Date) });
    expect(await verifier.run()).toBeNull(); // not due again for a day
    expect(await open('CHAIN_BROKEN')).toEqual([]);
  });

  it('a full verification opens CHAIN_BROKEN for an unacknowledged break anywhere in the chain', async () => {
    const [first] = await store.chainRange(1, 1);
    const owner = createDatabase({ connectionString: a.ownerUrl, maxConnections: 1 });
    await owner.pool.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable');
    await owner.pool.query(`UPDATE audit_records SET summary = 'old edit' WHERE id = $1`, [first!.entry.recordId]);
    await owner.pool.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable');
    await owner.close();
    await t.db.update(auditVerifications).set({ startedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) });
    const run = await new AuditFullVerifier(t.db, store, signer, { pageEntries: 10_000 }).run();
    expect(run).toMatchObject({ ok: false, finishedAt: expect.any(Date) });
    const [incident] = await open('CHAIN_BROKEN');
    expect(incident!.detail).toMatchObject({ firstBrokenAt: 1 });
    const status = await auditStoreStatus(t.db, store, signer);
    expect(status.fullVerification).toMatchObject({ ok: false });
    expect(status.warnings).toEqual([]);
    expect((await auditStoreStatus(t.db, store, signer, { expectReadOnly: true })).warnings[0]).toMatch(/write access/);
  });

  it('opens SIGNING_KEY_CHANGED when the last checkpoint is by a key the deployment does not trust', async () => {
    const head = (await store.chainHead())!;
    const other = loadSigningKey(generateSigningKeyPem());
    await store.appendCheckpoint(signCheckpoint(other, { upToPosition: head.position, chainHash: head.chainHash }));
    await new AuditSealer(t.db, store, signer).seal();
    const [incident] = await open('SIGNING_KEY_CHANGED');
    expect(incident!.detail).toMatchObject({ previousKeyId: other.keyId, currentKeyId: signer.keyId });
    // Trusting the retired key (AUDIT_TRUSTED_PUBLIC_KEYS) is what makes old checkpoints verify.
    await t.db.update(auditIncidents).set({ resolvedAt: new Date() }).where(eq(auditIncidents.kind, 'SIGNING_KEY_CHANGED'));
    await new AuditSealer(t.db, store, { ...signer, retiredKeys: [other] }).seal();
    expect(await open('SIGNING_KEY_CHANGED')).toEqual([]);
  });
});

describe('exports blocked and restores', () => {
  it('raises EXPORT_FAILED when nothing new is signed for two export periods', async () => {
    await write('blocked.one');
    await new AuditShipper(t.db, store).ship();
    await new AuditSealer(t.db, store, null).seal(); // sealed, never signed
    const now = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const exporter = new AuditExporter(t.db, store, { put: async () => {} }, signer, { now: () => now });
    expect(await exporter.exportDue()).toBeNull();
    const [incident] = await open('EXPORT_FAILED');
    expect(String(incident!.detail['error'])).toMatch(/no checkpoint signed by key/);
  });

  it('the local prune re-ships verified rows a restored store no longer holds instead of deleting them', async () => {
    const kept = await write('restore.kept');
    const lost = await write('restore.lost');
    await new AuditShipper(t.db, store).ship();
    await reconcileAudit(t.db, store, { graceSeconds: -1 });
    await backdateAudit(t.db, [kept, lost], 200);
    // The store "restored from a backup" forgets `lost`: has() no longer reports it.
    const restored = Object.assign(Object.create(store) as FlakyStore, {
      has: async (ids: readonly string[]) => new Set([...(await store.has(ids))].filter((id) => id !== lost)),
      purgeBefore: async () => 0,
    });
    await new RetentionService(t.db, { delete: async () => {} }, () => {}, restored).run();
    const rows = await t.db.select().from(auditEvents).where(inArray(auditEvents.id, [kept, lost]));
    expect(rows.map((r) => r.id)).toEqual([lost]);
    expect(rows[0]).toMatchObject({ shippedAt: null, verifiedAt: null });
  });
});
