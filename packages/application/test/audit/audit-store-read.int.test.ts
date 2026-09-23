import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { PostgresAuditStore, generateSigningKeyPem, loadSigningKey, verifySignature } from '@ocso/audit-store';
import type { Principal } from '@ocso/auth';
import { auditEvents, auditExports, auditIncidents, createDatabase, uuidv7 } from '@ocso/db';
import { createTestAuditDatabase, createTestDatabase, type TestAuditDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  AuditExporter,
  AuditSealer,
  AuditShipper,
  auditScope,
  auditStoreStatus,
  exportManifestMessage,
  readAudit,
  recordAudit,
  verifyAuditRange,
  type ActorContext,
} from '../../src/index.js';
import { createTeam } from '../support/ownership.js';
import { FlakyStore } from './support.js';

let t: TestDatabase;
let a: TestAuditDatabase;
let store: FlakyStore;
const signer = loadSigningKey(generateSigningKeyPem());
const teamA = uuidv7();
const teamB = uuidv7();
const leadA: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Ana', teamIds: [teamA], via: 'UI' };
const leadB: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Ben', teamIds: [teamB], via: 'UI' };
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tia', teamIds: [], via: 'UI' };
const as = (principal: Principal): ActorContext => ({ principal, correlationId: 'read-test' });
const write = (actor: Principal, action: string, targetType = 'thing') =>
  t.db.transaction((tx) => recordAudit(tx, as(actor), { action, targetType, targetId: uuidv7(), summary: `${actor.displayName} ${action}` }));
const q = (extra: Record<string, unknown> = {}) => ({ limit: 100, ...extra });

beforeAll(async () => {
  t = await createTestDatabase();
  a = await createTestAuditDatabase();
  store = new FlakyStore(new PostgresAuditStore({ connectionString: a.url }));
  await createTeam(t.db, teamA);
  await createTeam(t.db, teamB);
});
afterAll(async () => {
  await store?.close();
  await t?.drop();
  await a?.drop();
});

describe('merged read: the store plus the unshipped outbox', () => {
  it('shows shipped and not-yet-shipped events together, newest first, never twice', async () => {
    const shipped = await write(leadA, 'read.shipped');
    await new AuditShipper(t.db, store).ship();
    const pending = await write(leadA, 'read.pending');
    const { rows, source } = await readAudit(store, t.db, q({ action: 'read.' }), null);
    expect(source).toBe('store');
    expect(rows.map((r) => r.id)).toEqual([pending, shipped]);
    // The API row shape (web AuditEventSchema): no internal columns.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['action', 'actorId', 'actorName', 'actorType', 'after', 'before', 'confirmation', 'correlationId', 'id', 'ip', 'occurredAt', 'summary', 'targetId', 'targetType', 'via'].sort(),
    );
  });

  it("scopes both sides by the reader's teams, own actions and shared targets", async () => {
    await write(leadA, 'scope.a');
    await write(leadB, 'scope.b');
    await write(tech, 'scope.queue', 'queue');
    await new AuditShipper(t.db, store).ship();
    await write(leadB, 'scope.b-pending');
    const seen = async (p: Principal) => (await readAudit(store, t.db, q({ action: 'scope.' }), auditScope(p))).rows.map((r) => r.action).sort();
    expect(await seen(leadA)).toEqual(['scope.a', 'scope.queue']);
    expect(await seen(leadB)).toEqual(['scope.b', 'scope.b-pending', 'scope.queue']);
    expect(await seen(tech)).toEqual(['scope.a', 'scope.b', 'scope.b-pending', 'scope.queue']);
  });

  it('paginates across both sides with the (before, beforeId) cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await write(tech, 'page.x'));
    await new AuditShipper(t.db, store, { batch: 2, maxRounds: 1 }).ship();
    const first = (await readAudit(store, t.db, q({ action: 'page.', limit: 3 }), null)).rows;
    const last = first[first.length - 1]!;
    const second = (await readAudit(store, t.db, q({ action: 'page.', limit: 3, before: last.occurredAt.toISOString(), beforeId: last.id }), null)).rows;
    // Same order as one unpaginated read (occurredAt, then id, descending), nothing skipped or repeated.
    const whole = (await readAudit(store, t.db, q({ action: 'page.' }), null)).rows.map((r) => r.id);
    expect([...first, ...second].map((r) => r.id)).toEqual(whole);
    expect(new Set(whole)).toEqual(new Set(ids));
  });

  it('falls back to the local window when the store fails', async () => {
    const id = await write(tech, 'fallback.x');
    await new AuditShipper(t.db, store).ship();
    store.down = true;
    const errors: unknown[] = [];
    const { rows, source } = await readAudit(store, t.db, q({ action: 'fallback.' }), null, (e) => errors.push(e));
    store.down = false;
    expect(source).toBe('local');
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(errors).toHaveLength(1);
  });
});

describe('audit-seal and checkpoints', () => {
  it('chains everything shipped and signs a checkpoint that verifies', async () => {
    await new AuditShipper(t.db, store).ship();
    const result = await new AuditSealer(t.db, store, signer).seal();
    expect(result.sealed).toBeGreaterThan(5);
    expect(result.checkpoint).toMatchObject({ upToPosition: result.head, keyId: signer.keyId });
    const report = await verifyAuditRange(store, signer, {});
    expect(report).toMatchObject({ ok: true, from: 1, to: result.head, checkpoints: { valid: 1 } });
    // Nothing new: no new checkpoint.
    expect((await new AuditSealer(t.db, store, signer).seal()).checkpoint).toBeNull();
  });

  it('refuses to sign over a tampered range and opens CHAIN_BROKEN', async () => {
    await write(tech, 'seal.victim');
    await new AuditShipper(t.db, store).ship();
    await new AuditSealer(t.db, store, signer, { checkpointEvery: 1000 }).seal();
    const { entry } = (await store.chainRange((await store.chainHead())!.position, 1))[0]!;
    // The owner (not the writer the product uses) bypasses the trigger: the tamper an auditor must catch.
    const owner = createDatabase({ connectionString: a.ownerUrl, maxConnections: 1 });
    await owner.pool.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable');
    await owner.pool.query(`UPDATE audit_records SET summary = 'edited' WHERE id = $1`, [entry.recordId]);
    await owner.pool.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable');
    await owner.close();
    const sealed = await new AuditSealer(t.db, store, signer, { checkpointEvery: 1 }).seal();
    expect(sealed).toMatchObject({ checkpoint: null, broken: true });
    const [incident] = await t.db.select().from(auditIncidents).where(eq(auditIncidents.kind, 'CHAIN_BROKEN'));
    expect(incident).toMatchObject({ resolvedAt: null });
    expect(JSON.stringify(incident!.detail)).toContain('RECORD_HASH_MISMATCH');
  });
});

describe('audit-export', () => {
  it('writes the sealed range up to a checkpoint with a signed manifest, once a day', async () => {
    const blobs = new Map<string, Uint8Array>();
    const exporter = new AuditExporter(t.db, store, { put: async ({ key, data }) => void blobs.set(key, data) }, signer);
    const done = await exporter.exportDue();
    expect(done).toMatchObject({ fromPosition: 1, keyId: signer.keyId });
    const data = blobs.get(done!.blobKey)!;
    expect(done!.blobKey).toMatch(/^audit-exports\/\d{4}\/\d{2}\/\d{2}\/1-\d+\.ndjson\.gz$/);
    expect(createHash('sha256').update(data).digest('hex')).toBe(done!.sha256);
    const lines = gunzipSync(data).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { entry: { position: number } });
    expect(lines.map((l) => l.entry.position)).toEqual(Array.from({ length: done!.toPosition }, (_, i) => i + 1));
    const manifest = JSON.parse(Buffer.from(blobs.get(done!.manifestKey)!).toString('utf8')) as Record<string, unknown> & { signature: string; publicKey: { publicKeyPem: string } };
    expect(manifest).toMatchObject({ format: 'ocso-audit-export/1', from: 1, to: done!.toPosition, sha256: done!.sha256 });
    expect(verifySignature(manifest.publicKey.publicKeyPem, exportManifestMessage(manifest), manifest.signature)).toBe(true);
    expect(verifySignature(manifest.publicKey.publicKeyPem, exportManifestMessage({ ...manifest, to: 999 }), manifest.signature)).toBe(false);
    expect(await exporter.exportDue()).toBeNull();
    expect(await t.db.$count(auditExports)).toBe(1);
  });
});

describe('audit store status', () => {
  it('reports lag, backlog, sealing, exports and incidents; DOWN when the store is unreachable', async () => {
    await write(tech, 'status.pending');
    const status = await auditStoreStatus(t.db, store, signer);
    expect(status).toMatchObject({ driver: 'flaky', unshipped: 1, exports: { count: 1 }, signingKey: { keyId: signer.keyId } });
    expect(status.status).toBe('DEGRADED'); // CHAIN_BROKEN is open
    expect(status.sealedPosition).toBeGreaterThan(0);
    expect(status.lastCheckpoint).not.toBeNull();
    expect(status.incidents.map((i) => i.kind)).toContain('CHAIN_BROKEN');
    store.down = true;
    const down = await auditStoreStatus(t.db, store, signer);
    store.down = false;
    expect(down).toMatchObject({ status: 'DOWN', sealedPosition: null, unshipped: 1 });
    expect(await t.db.$count(auditEvents, isNull(auditEvents.shippedAt))).toBe(1);
  });
});
