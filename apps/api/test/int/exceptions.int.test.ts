import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionService, SettingsService, readZip, sampleStorage, verifyExportBundle, type AuditPublicKey, type AuditStore } from '@ocso/application';
import type { Principal } from '@ocso/auth';
import { createEvent } from '@ocso/events';
import { userPermissionGrants, uuidv7 } from '@ocso/db';
import { AUDIT_STORE } from '../../src/infrastructure/tokens.js';
import { RealtimeAccess } from '../../src/modules/realtime/realtime-access.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { createTeam, setTeams } from './teams.js';

/**
 * The exception report and storage endpoints (PM/research/11 §7, ADR-033):
 * who reads what (exceptions.read scoped, exceptions.sign whole), signing with
 * the audit signing key, the signed export verified against the published key,
 * and GET /v1/system/storage (system.read).
 */
let h: ApiHarness;
const tok = { admin: '', head: '', lead: '' };
const ids: Record<string, string> = {};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'a password 12345';

/** supertest: collect a binary body (the response is a Node stream). */
const binary = (res: unknown, done: (err: Error | null, body: Buffer) => void) => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  h = await startApi();
  tok.admin = await completeSetup(h);
  const mk = async (email: string, name: string, role: string) => (await h.http().post('/v1/users').set(auth(tok.admin)).send({ email, name, role, password: PASSWORD }).expect(201)).body.id as string;
  ids.head = await mk('anjali@ocso.test', 'Anjali Rao', 'HEAD');
  ids.lead = await mk('lena@ocso.test', 'Lena Lead', 'LEAD');
  tok.head = await h.loginAs('anjali@ocso.test', PASSWORD);
  tok.lead = await h.loginAs('lena@ocso.test', PASSWORD);
  ids.cards = await createTeam(h, tok.head, 'Cards');
  await setTeams(h, tok.admin, ids.lead, [ids.cards]);
  // A team item: a permission granted to the Lead without an approval (Lead is in Cards).
  await h.db.db.insert(userPermissionGrants).values({ id: uuidv7(), userId: ids.lead, permission: 'agents.delete', effect: 'GRANT', reason: 'seeded bypass' });
  // Last week's report, as the worker's leader task would freeze it.
  ids.report = (await h.app.get(ExceptionService).generateWeekly()).id!;
});
afterAll(async () => {
  await h?.close();
});

describe('exceptions over HTTP', () => {
  it('the live view: a Head sees everything, Tech (exceptions.read, no team) platform-wide items and people’s access, a Lead nothing', async () => {
    const head = (await h.http().get('/v1/exceptions/live').set(auth(tok.head)).expect(200)).body;
    expect(head.scoped).toBe(false);
    const bypass = head.content.sections.find((s: { id: string }) => s.id === 'permission_bypass');
    type Item = { objectId: string; title: string };
    const grant = (i: Item) => i.objectId === ids.lead && i.title.includes('agents.delete');
    expect(bypass.items.some(grant)).toBe(true);
    const tech = (await h.http().get('/v1/exceptions/live').set(auth(tok.admin)).expect(200)).body;
    expect(tech.scoped).toBe(true);
    // The grant is a Cards item, but it is about a person's access: Tech (users.read) owns access control and sees it.
    expect(tech.content.sections.find((s: { id: string }) => s.id === 'permission_bypass').items.some(grant)).toBe(true);
    // A Cards routing or agent item would stay hidden from Tech: only items readable deployment-wide cross teams.
    for (const section of tech.content.sections as Array<{ items: Array<{ teamIds: string[]; readableWith: string | null }> }>) {
      for (const i of section.items) expect(i.teamIds.length === 0 || i.readableWith === 'users.read').toBe(true);
    }
    await h.http().get('/v1/exceptions/live').set(auth(tok.lead)).expect(403);
    await h.http().get('/v1/exceptions/reports').set(auth(tok.lead)).expect(403);
  });

  it('lists and opens the weekly report; only signers get the sign and export affordances', async () => {
    const list = (await h.http().get('/v1/exceptions/reports').set(auth(tok.head)).expect(200)).body;
    expect(list.rows.map((r: { id: string }) => r.id)).toContain(ids.report);
    const forHead = (await h.http().get(`/v1/exceptions/reports/${ids.report}`).set(auth(tok.head)).expect(200)).body;
    expect(forHead).toMatchObject({ kind: 'WEEKLY', status: 'DRAFT', canSign: true, canExport: false, scoped: false });
    const forTech = (await h.http().get(`/v1/exceptions/reports/${ids.report}`).set(auth(tok.admin)).expect(200)).body;
    expect(forTech).toMatchObject({ canSign: false, scoped: true });
    await h.http().get(`/v1/exceptions/reports/${uuidv7()}`).set(auth(tok.head)).expect(404);
    await h.http().get('/v1/exceptions/reports/not-a-uuid').set(auth(tok.head)).expect(400);
  });

  it('a Head signs it (Tech cannot); the export verifies against the published key', async () => {
    const shown = (await h.http().get(`/v1/exceptions/reports/${ids.report}`).set(auth(tok.head)).expect(200)).body;
    await h.http().post(`/v1/exceptions/reports/${ids.report}/sign`).set(auth(tok.admin)).send({ contentHash: shown.contentHash }).expect(403);
    await h.http().get(`/v1/exceptions/reports/${ids.report}/export`).set(auth(tok.head)).expect(409);
    await h.http().post(`/v1/exceptions/reports/${ids.report}/sign`).set(auth(tok.head)).send({ contentHash: 'a'.repeat(64) }).expect(409);
    // Last week's report names nobody here: nothing to attest.
    expect(shown.attestationRequired).toEqual([]);
    const signed = (await h.http().post(`/v1/exceptions/reports/${ids.report}/sign`).set(auth(tok.head)).send({ contentHash: shown.contentHash, note: 'Reviewed' }).expect(200)).body;
    expect(signed).toMatchObject({ status: 'SIGNED', verification: 'VALID', keyTrust: 'CURRENT', signedBy: { id: ids.head, name: 'Anjali Rao' }, canExport: true, attestation: [] });
    await h.http().post(`/v1/exceptions/reports/${ids.report}/sign`).set(auth(tok.head)).send({ contentHash: shown.contentHash }).expect(409);
    await h.http().get(`/v1/exceptions/reports/${ids.report}/export`).set(auth(tok.admin)).expect(403);
    const res = await h.http().get(`/v1/exceptions/reports/${ids.report}/export`).set(auth(tok.head)).buffer(true).parse(binary).expect(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="ocso-exceptions-weekly-.*\.zip"/);
    const keys = (await h.http().get('/v1/audit/keys').set(auth(tok.admin)).expect(200)).body as AuditPublicKey[];
    const zip = res.body as Buffer;
    expect(verifyExportBundle(zip, keys)).toMatchObject({ ok: true });
    expect(readZip(zip).get('public-key.pem')!.toString()).toBe(keys[0]!.publicKeyPem);
    const log = (await h.http().get('/v1/audit').query({ targetType: 'exception_report' }).set(auth(tok.admin)).expect(200)).body as Array<{ action: string }>;
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['exception_report.sign', 'exception_report.export', 'exception_report.generate']));
  });

  it('a report naming the signer (her own account was created with the approval skipped) is signed only as self-attested', async () => {
    const report = (
      await h.http().post('/v1/exceptions/reports').set(auth(tok.head)).send({ periodStart: new Date(Date.now() - 3_600_000).toISOString(), periodEnd: new Date().toISOString() }).expect(201)
    ).body;
    expect(report.attestationRequired).toContain('self_attested');
    const refused = (await h.http().post(`/v1/exceptions/reports/${report.id}/sign`).set(auth(tok.head)).send({ contentHash: report.contentHash }).expect(409)).body;
    expect(refused).toMatchObject({ error: { code: 'attestation_required', details: { required: ['self_attested'] } } });
    const signed = (
      await h.http().post(`/v1/exceptions/reports/${report.id}/sign`).set(auth(tok.head)).send({ contentHash: report.contentHash, acknowledge: report.attestationRequired }).expect(200)
    ).body;
    expect(signed.attestation).toEqual([...report.attestationRequired].sort());
  });

  it('a Head creates an ad-hoc report over a past period', async () => {
    const start = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const end = new Date(Date.now() - 86_400_000).toISOString();
    const adhoc = (await h.http().post('/v1/exceptions/reports').set(auth(tok.head)).send({ periodStart: start, periodEnd: end }).expect(201)).body;
    expect(adhoc).toMatchObject({ kind: 'ADHOC', status: 'DRAFT', generatedBy: { id: ids.head } });
    await h.http().post('/v1/exceptions/reports').set(auth(tok.admin)).send({ periodStart: start, periodEnd: end }).expect(403);
    await h.http().post('/v1/exceptions/reports').set(auth(tok.head)).send({ periodStart: end, periodEnd: start }).expect(400);
    // Regenerating a draft replaces it (the old one is kept, superseded); Tech cannot.
    await h.http().post(`/v1/exceptions/reports/${adhoc.id}/regenerate`).set(auth(tok.admin)).send({ reason: 'a check failed' }).expect(403);
    await h.http().post(`/v1/exceptions/reports/${adhoc.id}/regenerate`).set(auth(tok.head)).send({}).expect(400);
    const fresh = (await h.http().post(`/v1/exceptions/reports/${adhoc.id}/regenerate`).set(auth(tok.head)).send({ reason: 'a check failed' }).expect(201)).body;
    expect(fresh).toMatchObject({ kind: 'ADHOC', status: 'DRAFT', periodStart: adhoc.periodStart });
    const old = (await h.http().get(`/v1/exceptions/reports/${adhoc.id}`).set(auth(tok.head)).expect(200)).body;
    expect(old).toMatchObject({ status: 'SUPERSEDED', supersededBy: fresh.id, canSign: false, signBlocked: 'superseded' });
    await h.http().post(`/v1/exceptions/reports/${ids.report}/regenerate`).set(auth(tok.head)).send({ reason: 'too late' }).expect(409);
  });
});

describe('the report-ready notice', () => {
  it('reaches exceptions.read holders only', async () => {
    const event = createEvent('exception_report.ready', { reportId: ids.report!, kind: 'WEEKLY', periodStart: '2026-09-14T00:00:00.000Z', periodEnd: '2026-09-21T00:00:00.000Z' }, { correlationId: 'test' });
    const who = (role: Principal['role']): Principal => ({ userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' });
    const allows = (p: Principal) => new RealtimeAccess(h.db.db, new SettingsService(h.db.db), p).allows(event);
    expect(await allows(who('HEAD'))).toBe(true);
    expect(await allows(who('TECH'))).toBe(true);
    expect(await allows(who('LEAD'))).toBe(false);
    expect(await allows(who('SERVICE'))).toBe(false);
  });
});

describe('storage over HTTP', () => {
  it('Tech reads table growth and the ClickHouse guidance; a Head without system.read does not', async () => {
    await sampleStorage(h.db.db, h.app.get<AuditStore>(AUDIT_STORE));
    const body = (await h.http().get('/v1/system/storage').set(auth(tok.admin)).expect(200)).body;
    expect(body.tables.length).toBeGreaterThan(40);
    expect(body.auditStore).toMatchObject({ driver: 'postgres' });
    expect(typeof body.auditStore.rows).toBe('number');
    expect(body.guidance.level).toBe('ok');
    await h.http().get('/v1/system/storage').set(auth(tok.head)).expect(403);
  });
});
