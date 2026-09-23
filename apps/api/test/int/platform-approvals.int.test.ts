import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { approveProposal, platformChecker, type Checker } from './platform.js';

/**
 * Platform objects under maker–checker over HTTP (PM/research/11 §4, COVERAGE-PLATFORM): the deployment
 * settings singleton through the generic approval routes, the audit floor refused at submit, and
 * credentials that never travel in a proposal.
 */

const SETTINGS = '00000000-0000-4000-8000-000000000001';
const SECRET = 'R0ut1ngKeyNotToLeak99';
let h: ApiHarness;
let admin: string;
let checker: Checker;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  checker = await platformChecker(h);
});
afterAll(async () => {
  await h?.close();
});

describe('deployment settings', () => {
  it('the singleton works with the generic approval routes: checkers, submit, state', async () => {
    const choice = await h.http().get('/v1/approvals/checkers').query({ objectKind: 'deployment_settings', objectId: SETTINGS }).set(auth(admin)).expect(200);
    expect(choice.body.checkers.map((c: { id: string }) => c.id)).toContain(checker.id);
    expect(choice.body).toMatchObject({ bootstrapAllowed: false, checkPermission: 'approvals.check.platform' });
    const submitted = await h
      .http()
      .post('/v1/approvals')
      .set(auth(admin))
      .send({ objectKind: 'deployment_settings', objectId: SETTINGS, action: 'UPDATE', checkerId: checker.id, reason: 'Rename the deployment', payload: { deployment: { deploymentLabel: 'UAT' } } })
      .expect(201);
    expect((await h.http().get('/v1/settings/approval').set(auth(admin)).expect(200)).body).toMatchObject({ approved: true, updateNeedsApproval: true, pending: { id: submitted.body.id } });
    // One settings proposal at a time.
    await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ orgName: 'Other', approval: { checkerId: checker.id, reason: 'x change' } }).expect(409);
    await approveProposal(h, checker, submitted.body);
    expect((await h.http().get('/v1/settings/deployment').set(auth(admin)).expect(200)).body.deploymentLabel).toBe('UAT');
  });

  it('refuses a retention below the audit floor at submit, and changes nothing', async () => {
    const low = await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ retention: { auditEvents: 30 }, approval: { checkerId: checker.id, reason: 'Shorter audit' } }).expect(400);
    expect(low.body.error.category).toBe('validation');
    const direct = await h
      .http()
      .post('/v1/approvals')
      .set(auth(admin))
      .send({ objectKind: 'deployment_settings', objectId: SETTINGS, action: 'UPDATE', checkerId: checker.id, reason: 'Shorter audit', payload: { retention: { auditEvents: 30 } } })
      .expect(400);
    expect(direct.body.error.code).toBe('invalid_payload');
    const retention = await h.http().get('/v1/settings/retention').set(auth(admin)).expect(200);
    expect(retention.body.find((r: { key: string }) => r.key === 'auditEvents').days).toBe(2555);
  });
});

describe('notification destinations', () => {
  it('a secret replacement travels as a secret ref: never in the proposal, its decisions or the audit log', async () => {
    const created = await h.http().post('/v1/notification-destinations').set(auth(admin)).send({ name: 'Incidents', kind: 'PAGERDUTY', config: { region: 'US' }, secret: 'R0ut1ngKeyR0ut1ngKey42' }).expect(201);
    expect(created.body.enabled).toBe(false);
    const enable = await h.http().patch(`/v1/notification-destinations/${created.body.id}`).set(auth(admin)).send({ enabled: true, approval: { checkerId: checker.id, reason: 'Page on-call' } }).expect(202);
    await approveProposal(h, checker, enable.body.proposal);
    const rotation = await h.http().patch(`/v1/notification-destinations/${created.body.id}`).set(auth(admin)).send({ secret: SECRET, approval: { checkerId: checker.id, reason: 'Rotate the key' } }).expect(202);
    expect(rotation.text).not.toContain(SECRET);
    expect((await h.http().get(`/v1/approvals/${rotation.body.proposal.id}`).set(auth(checker.token)).expect(200)).body.after).toMatchObject({ secret: 'new value (proposed)' });
    await approveProposal(h, checker, rotation.body.proposal);
    for (const table of ['approval_proposals', 'approval_decisions', 'audit_events', 'notification_destinations', 'outbox_events']) {
      const rows = await h.db.db.execute(sql.raw(`SELECT row_to_json(t)::text AS j FROM ${table} t`));
      expect(JSON.stringify(rows.rows), table).not.toContain(SECRET);
    }
    // Disabling is immediate, with no approval.
    expect((await h.http().patch(`/v1/notification-destinations/${created.body.id}`).set(auth(admin)).send({ enabled: false }).expect(200)).body.enabled).toBe(false);
  });
});

describe('create-and-activate', () => {
  it('a refused activation still answers 201 with the draft and activationError, so a retry reuses that draft', async () => {
    const body = { kind: 'ANTHROPIC', name: 'Scripted retry', region: 'global', residencyZone: 'GLOBAL', credentials: { apiKey: 'sk-ant-retry-0000000000' }, enabled: true };
    // The admin names themselves: not an eligible checker. The draft exists; its activation was refused.
    const refused = await h.http().post('/v1/model-providers').set(auth(admin)).send({ ...body, approval: { checkerId: (await h.http().get('/v1/auth/me').set(auth(admin))).body.id, reason: 'Go live' } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(201);
    expect(refused.body).toMatchObject({ name: 'Scripted retry', enabled: false, activationError: { code: 'checker_not_eligible' } });
    expect(refused.body.proposal).toBeUndefined();
    // Retrying the activation on the same id (no duplicate draft).
    await h.http().patch(`/v1/model-providers/${refused.body.id}`).set(auth(admin)).send({ enabled: true, approval: { checkerId: checker.id, reason: 'Go live' } }).expect(202);
    const same = await h.db.db.execute(sql`SELECT count(*)::int AS n FROM model_providers WHERE name = 'Scripted retry'`);
    expect((same.rows[0] as { n: number }).n).toBe(1);
  });
});
