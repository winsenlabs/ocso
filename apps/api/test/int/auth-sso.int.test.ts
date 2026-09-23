import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activateUser, loadPrincipal } from '@ocso/application';
import { users } from '@ocso/db';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { MiniIdp } from './mini-idp.js';

/**
 * SSO (ADR-025): Tech admin-only provider management, and the provisioning
 * policy end to end against a local OIDC provider — invited users link,
 * strangers are refused unless auto-provisioning is on (and then wait for
 * approval like any new user: PM/research/11 §2.7), and an IdP cannot vouch
 * for addresses outside its domains. A governed deployment (approval not skipped).
 */
const SECRET = 'client-secret-never-returned';
let h: ApiHarness;
let admin: string;
const idp = new MiniIdp();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** SP-initiated sign-in: start at OCSO, "authenticate" at the IdP, come back to the callback. */
async function ssoSignIn(email: string, asserted = email) {
  const start = await h.http().post('/api/auth/sign-in/sso').send({ email, callbackURL: '/', errorCallbackURL: '/login?sso=failed' }).expect(200);
  const authorize = new URL(start.body.url);
  expect(authorize.origin).toBe(idp.issuer);
  idp.nonce = authorize.searchParams.get('nonce') ?? undefined;
  idp.nextUser = { sub: `sub-${asserted}`, email: asserted, name: asserted.split('@')[0]! };
  const cookies = ([] as string[]).concat(start.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!);
  const callback = await h
    .http()
    .get(`/api/auth/sso/callback/corp?code=test-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`)
    .set('cookie', cookies.join('; '));
  return { status: callback.status, location: String(callback.headers['location'] ?? ''), token: callback.headers['set-auth-token'] as string | undefined };
}

beforeAll(async () => {
  const issuer = await idp.start();
  process.env['OCSO_AUTH_TRUSTED_ORIGINS'] = issuer;
  h = await startApi({ env: { OCSO_DEV_SKIP_ACCESS_APPROVAL: 'false' } });
  admin = await completeSetup(h);
});

/** What approving a user's creation does (the approval spine calls it in wave 2). */
async function approve(email: string) {
  const [row] = await h.db.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  const [me] = await h.db.db.select({ id: users.id }).from(users).where(eq(users.role, 'TECH'));
  const principal = (await loadPrincipal(h.db.db, me!.id, 'SYSTEM'))!;
  await h.db.db.transaction((tx) => activateUser(tx, { principal, correlationId: 'sso-test' }, row!.id));
}
afterAll(async () => {
  delete process.env['OCSO_AUTH_TRUSTED_ORIGINS'];
  await h?.close();
  await idp.stop();
});

/** The lead (a Head, who holds approvals.check.platform) approves the Tech admin's SSO changes. */
let lead = '';
let leadId = '';
async function approveAsLead(proposal: { id: string; contentHash: string }) {
  await h.http().post(`/v1/approvals/${proposal.id}/decision`).set(bearer(lead)).send({ decision: 'APPROVE', reason: 'ok', contentHash: proposal.contentHash }).expect(200);
}

describe('SSO providers', () => {
  it('only the Tech admin manages providers; client secrets are write-only; a new provider is a draft until approved', async () => {
    leadId = (await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'lead@ocso.test', name: 'Lead', role: 'HEAD', password: 'lead password 12345' }).expect(201)).body.id;
    await approve('lead@ocso.test');
    lead = await h.loginAs('lead@ocso.test', 'lead password 12345');
    await h.http().get('/v1/settings/sso-providers').set(bearer(lead)).expect(403);
    const body = { providerId: 'corp', name: 'Corp SSO', type: 'oidc', domains: ['corp.test'], oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: SECRET } };
    await h.http().post('/v1/settings/sso-providers').set(bearer(lead)).send(body).expect(403);
    const created = await h.http().post('/v1/settings/sso-providers').set(bearer(admin)).send(body).expect(201);
    expect(created.body).toMatchObject({ providerId: 'corp', status: 'DRAFT', type: 'oidc', domains: ['corp.test'], autoProvision: false, callbackUrl: 'http://localhost:3000/api/auth/sso/callback/corp' });
    // A draft is not offered on the sign-in page; activating it is a proposal the lead approves.
    expect((await h.http().get('/v1/setup/status').expect(200)).body.sso).toBe(false);
    await h.http().post('/v1/settings/sso-providers/corp/status').set(bearer(admin)).send({ status: 'ACTIVE' }).expect(409);
    const activation = await h.http().post('/v1/settings/sso-providers/corp/status').set(bearer(admin)).send({ status: 'ACTIVE', approval: { checkerId: leadId, reason: 'Corp sign-in' } }).expect(202);
    expect(JSON.stringify(activation.body)).not.toContain(SECRET);
    await approveAsLead(activation.body.proposal);
    const list = await h.http().get('/v1/settings/sso-providers').set(bearer(admin)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(JSON.stringify(created.body)).not.toContain(SECRET);
    const { rows } = await h.db.pool.query(`SELECT after::text AS after FROM audit_events WHERE action = 'sso.provider_create'`);
    expect(rows[0].after).not.toContain(SECRET);
    expect((await h.http().get('/v1/setup/status').expect(200)).body.sso).toBe(true);
    // Better Auth's own provider endpoints are closed over HTTP.
    await h.http().post('/api/auth/sso/register').set(bearer(admin)).send({ providerId: 'x', issuer: idp.issuer, domain: 'x.test' }).expect(404);
  });

  it('links an invited user by email and accepts their invite', async () => {
    await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'ana@corp.test', name: 'Ana', role: 'SERVICE' }).expect(201);
    // Not yet approved: the IdP cannot sign them in.
    expect((await ssoSignIn('ana@corp.test')).token).toBeUndefined();
    await approve('ana@corp.test');
    const result = await ssoSignIn('ana@corp.test');
    expect(result.status).toBe(302);
    expect(result.token).toBeTruthy();
    const me = await h.http().get('/v1/auth/me').set(bearer(result.token!)).expect(200);
    expect(me.body).toMatchObject({ role: 'SERVICE', session: { method: 'sso' } });
    const [ana] = await h.db.db.select().from(users).where(eq(users.email, 'ana@corp.test'));
    expect(ana).toMatchObject({ emailVerified: true, inviteExpiresAt: null });
  });

  it('refuses unknown users unless auto-provisioning is on, then creates them as a Service member pending approval', async () => {
    const refused = await ssoSignIn('bob@corp.test');
    expect(refused.token).toBeUndefined();
    expect(await h.db.db.select().from(users).where(eq(users.email, 'bob@corp.test'))).toHaveLength(0);
    // Approved: a change is a proposal.
    await h.http().patch('/v1/settings/sso-providers/corp').set(bearer(admin)).send({ autoProvision: true }).expect(409);
    const change = await h.http().patch('/v1/settings/sso-providers/corp').set(bearer(admin)).send({ autoProvision: true, approval: { checkerId: leadId, reason: 'Auto-provision' } }).expect(202);
    await approveAsLead(change.body.proposal);
    // Creating a user is an increase: the IdP account exists in OCSO but cannot sign in until approved.
    const provisioned = await ssoSignIn('bob@corp.test');
    expect(provisioned.token).toBeUndefined();
    const [bob] = await h.db.db.select().from(users).where(eq(users.email, 'bob@corp.test'));
    expect(bob).toMatchObject({ role: 'SERVICE', status: 'PENDING_APPROVAL' });
    const { rows } = await h.db.pool.query(`SELECT after FROM audit_events WHERE action = 'user.create' AND target_id = $1`, [bob!.id]);
    expect(rows[0].after).toMatchObject({ provisionedBy: 'sso', status: 'PENDING_APPROVAL' });
    expect((await ssoSignIn('bob@corp.test')).token).toBeUndefined();
    const again = await h.db.pool.query(`SELECT summary FROM audit_events WHERE action = 'auth.sso_rejected' AND summary LIKE '%account_pending_approval%'`);
    expect(again.rows.length).toBeGreaterThan(0);
    await approve('bob@corp.test');
    expect((await ssoSignIn('bob@corp.test')).token).toBeTruthy();
  });

  it('refuses an IdP assertion for an address outside the provider domains', async () => {
    const result = await ssoSignIn('carol@corp.test', 'carol@elsewhere.test');
    expect(result.token).toBeUndefined();
    expect(await h.db.db.select().from(users).where(eq(users.email, 'carol@elsewhere.test'))).toHaveLength(0);
    const { rows } = await h.db.pool.query(`SELECT summary FROM audit_events WHERE action = 'auth.sso_rejected'`);
    expect(rows.map((r: { summary: string }) => r.summary).join(' ')).toContain('sso_domain_not_allowed');
  });

  it('removes a provider through an approval', async () => {
    await h.http().delete('/v1/settings/sso-providers/corp').set(bearer(admin)).expect(409);
    const removal = await h.http().delete('/v1/settings/sso-providers/corp').set(bearer(admin)).send({ approval: { checkerId: leadId, reason: 'Moving IdP' } }).expect(202);
    await approveAsLead(removal.body.proposal);
    expect((await h.http().get('/v1/setup/status').expect(200)).body.sso).toBe(false);
    await h.http().post('/api/auth/sign-in/sso').send({ email: 'ana@corp.test', callbackURL: '/' }).expect(404);
  });
});
