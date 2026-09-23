import { createHash, createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditFullVerifier, AuditSealer, AuditShipper, type AuditSigner, type AuditStore } from '@ocso/application';
import { createDatabase } from '@ocso/db';
import { AUDIT_SIGNER, AUDIT_STORE } from '../../src/infrastructure/tokens.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * The audit store through the API (ADR-032): reads merge the store with the
 * unshipped outbox, the keys and verify endpoints, the System status, the
 * health dependency report, and their permissions. The worker is not running
 * here, so the test ships and seals with the same services the leader uses.
 */
let h: ApiHarness;
let admin: string;
let head: string;
let store: AuditStore;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  await h.http().post('/v1/users').set(auth(admin)).send({ email: 'head@ocso.test', name: 'Head', role: 'HEAD', password: 'a password 12345' }).expect(201);
  head = await h.loginAs('head@ocso.test', 'a password 12345');
  store = h.app.get<AuditStore>(AUDIT_STORE);
});
afterAll(async () => {
  await h?.close();
});

const shipAndSeal = async () => {
  await new AuditShipper(h.db.db, store).ship();
  return new AuditSealer(h.db.db, store, h.app.get<AuditSigner>(AUDIT_SIGNER), { checkpointEvery: 1 }).seal();
};

describe('audit store through the API', () => {
  it('serves the log from the store merged with events not shipped yet', async () => {
    const before = await h.http().get('/v1/audit?limit=500').set(auth(admin)).expect(200);
    expect(before.headers['x-ocso-audit-source']).toBe('store');
    const unshipped = (before.body as Array<{ action: string }>).map((e) => e.action);
    expect(unshipped.length).toBeGreaterThan(2);
    await shipAndSeal();
    const after = await h.http().get('/v1/audit?limit=500').set(auth(admin)).expect(200);
    expect((after.body as Array<{ action: string }>).map((e) => e.action)).toEqual(unshipped);
    expect(Object.keys(after.body[0]).sort()).toEqual(Object.keys(before.body[0]).sort());
  });

  it('publishes the verification key and verifies the chain (audited)', async () => {
    const keys = (await h.http().get('/v1/audit/keys').set(auth(admin)).expect(200)).body as Array<{ keyId: string; algorithm: string; publicKeyPem: string }>;
    expect(keys).toHaveLength(1);
    const publicKey = createPublicKey(keys[0]!.publicKeyPem);
    expect(createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)).toBe(keys[0]!.keyId);
    // The checkpoint verifies with nothing but the published key (what an auditor does offline).
    const [c] = await store.checkpoints({ limit: 1 });
    const message = `ocso-audit-checkpoint\n${c!.upToPosition}\n${c!.chainHash}\n${c!.createdAt.toISOString()}`;
    expect(verify(null, Buffer.from(message), publicKey, Buffer.from(c!.signature, 'base64'))).toBe(true);
    const report = (await h.http().post('/v1/audit/verify').set(auth(admin)).send({}).expect(200)).body;
    expect(report).toMatchObject({ ok: true, from: 1, problems: [], checkpoints: { valid: 1 } });
    const log = (await h.http().get('/v1/audit?action=audit.verify').set(auth(admin)).expect(200)).body;
    expect(log[0]).toMatchObject({ action: 'audit.verify', targetType: 'audit_store' });
  });

  it('reports a tampered record', async () => {
    const { entry } = (await store.chainRange(1, 1))[0]!;
    const owner = createDatabase({ connectionString: h.auditDb.ownerUrl, maxConnections: 1 });
    await owner.pool.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable');
    await owner.pool.query(`UPDATE audit_records SET actor_name = 'Someone else' WHERE id = $1`, [entry.recordId]);
    await owner.pool.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable');
    await owner.close();
    const report = (await h.http().post('/v1/audit/verify').set(auth(admin)).send({ from: 1, to: 3 }).expect(200)).body;
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatchObject({ kind: 'RECORD_HASH_MISMATCH', position: 1, recordId: entry.recordId });
    await h.http().post('/v1/audit/verify').set(auth(admin)).send({ from: 5, to: 2 }).expect(400);
  });

  it('lets audit.verify acknowledge a chain break the full verification found (audited, once)', async () => {
    await new AuditFullVerifier(h.db.db, store, h.app.get<AuditSigner>(AUDIT_SIGNER)).run();
    const broken = ((await h.http().get('/v1/audit/store').set(auth(admin)).expect(200)).body.incidents as Array<{ id: string; kind: string; detail: Record<string, unknown> }>).find((i) => i.kind === 'CHAIN_BROKEN');
    expect(broken!.detail).toMatchObject({ firstBrokenAt: 1, lastBrokenAt: 1 });
    const path = `/v1/audit/incidents/${broken!.id}/acknowledge`;
    await h.http().post(path).set(auth(head)).send({ note: 'Investigated: a test edit by the DBA.' }).expect(403);
    await h.http().post(path).send({ note: 'Investigated: a test edit by the DBA.' }).expect(401);
    await h.http().post(path).set(auth(admin)).send({ note: 'short' }).expect(400);
    const done = (await h.http().post(path).set(auth(admin)).send({ note: 'Investigated: a test edit by the DBA.' }).expect(200)).body;
    expect(done.resolvedAt).not.toBeNull();
    await h.http().post(path).set(auth(admin)).send({ note: 'Investigated: a test edit by the DBA.' }).expect(404);
    const status = (await h.http().get('/v1/audit/store').set(auth(admin)).expect(200)).body;
    expect(status.incidents.map((i: { kind: string }) => i.kind)).not.toContain('CHAIN_BROKEN');
    const log = (await h.http().get('/v1/audit?action=audit.chain_acknowledge').set(auth(admin)).expect(200)).body;
    expect(log[0]).toMatchObject({ targetType: 'audit_store', targetId: broken!.id });
  });

  it('reports store status to the System screen and in the dependency health, never in readiness', async () => {
    const status = (await h.http().get('/v1/audit/store').set(auth(admin)).expect(200)).body;
    expect(status).toMatchObject({ driver: 'postgres', health: { ok: true } });
    expect(status.sealedPosition).toBeGreaterThan(0);
    expect(status.lastCheckpoint.keyId).toHaveLength(16);
    const deps = (await h.http().get('/health/dependencies').set(auth(admin)).expect(200)).body;
    expect(deps.auditStore).toMatchObject({ status: 'ok', driver: 'postgres' });
    expect(typeof deps.auditStore.lagSeconds).toBe('number');
    await h.http().get('/health/ready').expect(200);
  });

  it('keeps verification and store status to their permissions', async () => {
    await h.http().post('/v1/audit/verify').set(auth(head)).send({}).expect(403);
    await h.http().get('/v1/audit/store').set(auth(head)).expect(403);
    await h.http().get('/v1/audit/keys').set(auth(head)).expect(200);
    await h.http().get('/v1/audit/keys').expect(401);
  });
});
