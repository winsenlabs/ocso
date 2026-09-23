import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@ocso/db';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { MiniIdp } from './mini-idp.js';

/**
 * SSO (ADR-025): Tech Admin-only provider management, and the provisioning
 * policy end to end against a local OIDC provider — invited users link,
 * strangers are refused unless auto-provisioning is on, and an IdP cannot
 * vouch for addresses outside its domains.
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
  h = await startApi();
  admin = await completeSetup(h);
});
afterAll(async () => {
  delete process.env['OCSO_AUTH_TRUSTED_ORIGINS'];
  await h?.close();
  await idp.stop();
});

describe('SSO providers', () => {
  it('only the Tech Admin manages providers; client secrets are write-only', async () => {
    await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'lead@ocso.test', name: 'Lead', role: 'CS_LEAD', password: 'lead password 12345' }).expect(201);
    const lead = await h.loginAs('lead@ocso.test', 'lead password 12345');
    await h.http().get('/v1/settings/sso-providers').set(bearer(lead)).expect(403);
    const body = { providerId: 'corp', name: 'Corp SSO', type: 'oidc', domains: ['corp.test'], oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: SECRET } };
    await h.http().post('/v1/settings/sso-providers').set(bearer(lead)).send(body).expect(403);
    const created = await h.http().post('/v1/settings/sso-providers').set(bearer(admin)).send(body).expect(201);
    expect(created.body).toMatchObject({ providerId: 'corp', type: 'oidc', domains: ['corp.test'], autoProvision: false, callbackUrl: 'http://localhost:3000/api/auth/sso/callback/corp' });
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
    await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'ana@corp.test', name: 'Ana', role: 'CS_EXEC' }).expect(201);
    const result = await ssoSignIn('ana@corp.test');
    expect(result.status).toBe(302);
    expect(result.token).toBeTruthy();
    const me = await h.http().get('/v1/auth/me').set(bearer(result.token!)).expect(200);
    expect(me.body).toMatchObject({ role: 'CS_EXEC', session: { method: 'sso' } });
    const [ana] = await h.db.db.select().from(users).where(eq(users.email, 'ana@corp.test'));
    expect(ana).toMatchObject({ emailVerified: true, inviteExpiresAt: null });
  });

  it('refuses unknown users unless auto-provisioning is on, then creates them as CS Exec', async () => {
    const refused = await ssoSignIn('bob@corp.test');
    expect(refused.token).toBeUndefined();
    expect(await h.db.db.select().from(users).where(eq(users.email, 'bob@corp.test'))).toHaveLength(0);
    await h.http().patch('/v1/settings/sso-providers/corp').set(bearer(admin)).send({ autoProvision: true }).expect(200);
    const provisioned = await ssoSignIn('bob@corp.test');
    expect(provisioned.token).toBeTruthy();
    const [bob] = await h.db.db.select().from(users).where(eq(users.email, 'bob@corp.test'));
    expect(bob).toMatchObject({ role: 'CS_EXEC', status: 'ACTIVE' });
  });

  it('refuses an IdP assertion for an address outside the provider domains', async () => {
    const result = await ssoSignIn('carol@corp.test', 'carol@elsewhere.test');
    expect(result.token).toBeUndefined();
    expect(await h.db.db.select().from(users).where(eq(users.email, 'carol@elsewhere.test'))).toHaveLength(0);
    const { rows } = await h.db.pool.query(`SELECT summary FROM audit_events WHERE action = 'auth.sso_rejected'`);
    expect(rows.map((r: { summary: string }) => r.summary).join(' ')).toContain('sso_domain_not_allowed');
  });

  it('removes a provider', async () => {
    await h.http().delete('/v1/settings/sso-providers/corp').set(bearer(admin)).expect(204);
    expect((await h.http().get('/v1/setup/status').expect(200)).body.sso).toBe(false);
    await h.http().post('/api/auth/sign-in/sso').send({ email: 'ana@corp.test', callbackURL: '/' }).expect(404);
  });
});
