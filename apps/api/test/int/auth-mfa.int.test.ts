import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authAccounts, users } from '@ocso/db';
import { ADMIN, completeSetup, startApi, type ApiHarness } from './harness.js';
import { totpFromUri } from './totp.js';

/** TOTP two-factor, "require MFA for roles", the break-glass rule and recovery (ADR-025). */
const RECOVERY_TOKEN = 'recovery-token-0123456789-abcdefghijklmnop';
const LEAD = { email: 'lead@ocso.test', password: 'lead password 12345' };
const ORIGIN = 'http://localhost:3000';

let h: ApiHarness;
let admin: string;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const tokenOf = (res: { headers: Record<string, unknown> }) => res.headers['set-auth-token'] as string;
const cookiesOf = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []).map((c) => c.split(';')[0]!);
const signIn = (email: string, password: string) => h.http().post('/api/auth/sign-in/email').send({ email, password });

beforeAll(async () => {
  process.env['OCSO_RECOVERY_TOKEN'] = RECOVERY_TOKEN;
  h = await startApi();
  admin = await completeSetup(h);
  await h.http().post('/v1/users').set(bearer(admin)).send({ email: LEAD.email, name: 'Lead', role: 'HEAD', password: LEAD.password }).expect(201);
});
afterAll(async () => {
  delete process.env['OCSO_RECOVERY_TOKEN'];
  await h?.close();
});

describe('require MFA for roles + TOTP', () => {
  let totpUri = '';
  let backupCodes: string[] = [];

  it('only the Tech admin sets the policy', async () => {
    const lead = tokenOf(await signIn(LEAD.email, LEAD.password).expect(200));
    await h.http().put('/v1/settings/auth-policy').set(bearer(lead)).send({ requireMfaRoles: [] }).expect(403);
    const res = await h.http().put('/v1/settings/auth-policy').set(bearer(admin)).send({ requireMfaRoles: ['HEAD'] }).expect(200);
    expect(res.body.requireMfaRoles).toEqual(['HEAD']);
  });

  it('a password-only session of a role that requires MFA can only enrol', async () => {
    const lead = tokenOf(await signIn(LEAD.email, LEAD.password).expect(200));
    expect((await h.http().get('/v1/auth/me').set(bearer(lead)).expect(200)).body.mfa).toEqual({ required: true, satisfied: false, enrolled: false });
    expect((await h.http().get('/v1/users').set(bearer(lead)).expect(403)).body.error.code).toBe('mfa_enrollment_required');
    expect((await h.http().get('/api/auth/list-sessions').set(bearer(lead)).expect(403)).body.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const enabled = await h.http().post('/api/auth/two-factor/enable').set(bearer(lead)).send({ password: LEAD.password }).expect(200);
    totpUri = enabled.body.totpURI;
    backupCodes = enabled.body.backupCodes;
    expect(totpUri).toMatch(/^otpauth:\/\/totp\/OCSO:lead%40ocso\.test\?/);
    expect(backupCodes).toHaveLength(10);
    await h.http().post('/api/auth/two-factor/verify-totp').set(bearer(lead)).send({ code: '000000' }).expect(401);
    const verified = await h.http().post('/api/auth/two-factor/verify-totp').set(bearer(lead)).send({ code: totpFromUri(totpUri) }).expect(200);
    const upgraded = tokenOf(verified);
    expect(upgraded).toBeTruthy();
    await h.http().get('/v1/auth/me').set(bearer(lead)).expect(401);
    expect((await h.http().get('/v1/auth/me').set(bearer(upgraded)).expect(200)).body.mfa).toEqual({ required: true, satisfied: true, enrolled: true });
    await h.http().get('/v1/users').set(bearer(upgraded)).expect(200);
  });

  it('signing in again asks for the authenticator code, or a backup code once', async () => {
    const first = await signIn(LEAD.email, LEAD.password).expect(200);
    expect(first.body.twoFactorRedirect).toBe(true);
    expect(tokenOf(first)).toBeUndefined();
    const challenge = cookiesOf(first).filter((c) => c.startsWith('ocso.two_factor='));
    expect(challenge).toHaveLength(1);
    const ok = await h.http().post('/api/auth/two-factor/verify-totp').set('cookie', challenge.join('; ')).set('origin', ORIGIN).send({ code: totpFromUri(totpUri) }).expect(200);
    expect((await h.http().get('/v1/auth/me').set(bearer(tokenOf(ok))).expect(200)).body.session.method).toBe('mfa');

    const second = await signIn(LEAD.email, LEAD.password).expect(200);
    const cookie = cookiesOf(second).filter((c) => c.startsWith('ocso.two_factor='));
    const viaBackup = await h.http().post('/api/auth/two-factor/verify-backup-code').set('cookie', cookie.join('; ')).set('origin', ORIGIN).send({ code: backupCodes[0] }).expect(200);
    await h.http().get('/v1/users').set(bearer(tokenOf(viaBackup))).expect(200);
    const third = await signIn(LEAD.email, LEAD.password).expect(200);
    const again = cookiesOf(third).filter((c) => c.startsWith('ocso.two_factor='));
    await h.http().post('/api/auth/two-factor/verify-backup-code').set('cookie', again.join('; ')).set('origin', ORIGIN).send({ code: backupCodes[0] }).expect(401);
  });

  it('the JSON sign-in for API clients refuses accounts with two-factor', async () => {
    const res = await h.http().post('/v1/auth/login').send(LEAD).expect(401);
    expect(res.body.error.code).toBe('mfa_required');
  });

  it('audits enrolment and second-factor sign-ins', async () => {
    const { rows } = await h.db.pool.query(`SELECT action FROM audit_events WHERE action LIKE 'auth.%' ORDER BY occurred_at`);
    const actions = rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.policy_update', 'auth.mfa_enrollment_started', 'auth.mfa_enrolled', 'auth.login']));
  });
});

describe('break-glass', () => {
  it('refuses to demote or disable the last active Tech admin who can sign in with a password', async () => {
    const created = await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'admin2@ocso.test', name: 'Admin Two', role: 'TECH', password: 'admin two password 1' }).expect(201);
    const second = tokenOf(await signIn('admin2@ocso.test', 'admin two password 1').expect(200));
    const [first] = await h.db.db.select().from(users).where(eq(users.email, ADMIN.email));
    // Admin Two becomes SSO-only (no password): the first admin is now the last password admin.
    await h.db.db.delete(authAccounts).where(eq(authAccounts.userId, created.body.id));
    const res = await h.http().patch(`/v1/users/${first!.id}`).set(bearer(second)).send({ status: 'DISABLED' }).expect(409);
    expect(res.body.error.code).toBe('last_password_admin');
    await h.http().patch(`/v1/users/${first!.id}`).set(bearer(second)).send({ role: 'HEAD' }).expect(409);
  });

  it('recovery token: resets a Tech admin password once, removes their authenticator and ends their sessions', async () => {
    const before = tokenOf(await signIn(ADMIN.email, ADMIN.password).expect(200));
    expect((await h.http().get('/v1/setup/status').expect(200)).body.recovery).toBe(true);
    await h.http().post('/v1/setup/recover').send({ recoveryToken: 'x'.repeat(40), email: ADMIN.email, newPassword: 'recovered password 1' }).expect(401);
    await h.http().post('/v1/setup/recover').send({ recoveryToken: RECOVERY_TOKEN, email: LEAD.email, newPassword: 'recovered password 1' }).expect(401);
    await h.http().post('/v1/setup/recover').send({ recoveryToken: RECOVERY_TOKEN, email: ADMIN.email, newPassword: 'recovered password 1' }).expect(200);
    await h.http().get('/v1/auth/me').set(bearer(before)).expect(401);
    await signIn(ADMIN.email, 'recovered password 1').expect(200);
    const reused = await h.http().post('/v1/setup/recover').send({ recoveryToken: RECOVERY_TOKEN, email: ADMIN.email, newPassword: 'another password 12' }).expect(401);
    expect(reused.body.error.code).toBe('recovery_token_used');
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.recovery'`);
    expect(rows[0].n).toBe(1);
  });
});
