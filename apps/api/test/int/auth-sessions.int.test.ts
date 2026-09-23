import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { authSessions, users } from '@ocso/db';
import { ADMIN, completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * Better Auth sessions end to end through the API (ADR-025): sign-in, the
 * guard, revocation on role change / deactivation, invites, password reset and
 * change, and long-lived streams closing when their session ends.
 */
let h: ApiHarness;
let admin: string;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const me = (token: string) => h.http().get('/v1/auth/me').set(bearer(token));
const signIn = (email: string, password: string, ip?: string) => {
  const req = h.http().post('/api/auth/sign-in/email');
  return (ip ? req.set('x-ocso-client-ip', ip) : req).send({ email, password });
};

beforeAll(async () => {
  process.env['SESSION_STREAM_RECHECK_SECONDS'] = '1';
  h = await startApi();
  admin = await completeSetup(h);
});
afterAll(async () => {
  delete process.env['SESSION_STREAM_RECHECK_SECONDS'];
  await h?.close();
});

describe('sign-in and the /v1 guard', () => {
  it('signs in case-insensitively; the bearer token authenticates /v1, the session cookie does not', async () => {
    const res = await signIn(ADMIN.email.toUpperCase(), ADMIN.password).expect(200);
    const token = res.headers['set-auth-token'] as string;
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ocso.session_token='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await me(token).expect(200)).body).toMatchObject({ role: 'TECH', session: { method: 'password' }, mfa: { required: false } });
    await h.http().get('/v1/auth/me').set('cookie', cookie.split(';')[0]!).expect(401);
    // Only signed tokens are accepted (bearer plugin requireSignature) and a tampered signature fails.
    await me(token.split('.')[0]!).expect(401);
    await me(`${token.slice(0, -3)}abc`).expect(401);
    await h.http().get('/v1/users').expect(401);
  });

  it('rejects a wrong password, then throttles the account', async () => {
    const res = await signIn(ADMIN.email, 'not the password').expect(401);
    expect(res.body.code).toBe('INVALID_EMAIL_OR_PASSWORD');
    for (let i = 0; i < 7; i++) await signIn(ADMIN.email, 'not the password').expect(401);
    expect((await signIn(ADMIN.email, ADMIN.password).expect(429)).body.code).toBe('TOO_MANY_ATTEMPTS');
    // The compatibility JSON sign-in goes through the same Better Auth endpoint.
    expect((await h.http().post('/v1/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(401)).body.error.code).toBe('too_many_attempts');
    await h.db.db.execute(sql`DELETE FROM login_attempts`);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.login_failed'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(8);
  });

  it('rate-limits sign-in per client address (Better Auth, database storage)', async () => {
    let limited = 0;
    for (let i = 0; i < 32; i++) if ((await signIn(`nobody${i}@ocso.test`, 'wrong password 123', '198.51.100.23')).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    await h.db.db.execute(sql`DELETE FROM auth_rate_limits; DELETE FROM login_attempts`);
  });

  it('keeps the /v1/auth/login JSON sign-in for API clients', async () => {
    const res = await h.http().post('/v1/auth/login').send({ email: ADMIN.email, password: ADMIN.password }).expect(200);
    expect(res.body.user.role).toBe('TECH');
    await me(res.body.token).expect(200);
    await h.http().post('/v1/auth/logout').set(bearer(res.body.token)).expect(204);
    await me(res.body.token).expect(401);
  });
});

describe('user lifecycle', () => {
  const LEAD = { email: 'lead@ocso.test', password: 'lead password 12345' };

  it('invites a user: the emailed link sets their password, then they sign in', async () => {
    const created = await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'Lead@ocso.test', name: 'Lead', role: 'HEAD' }).expect(201);
    expect(created.body).toMatchObject({ email: 'lead@ocso.test', invite: { status: 'pending' }, onboarding: { kind: 'invite', delivery: { delivered: true } } });
    // Log driver: the inviting admin also gets the link to hand over.
    expect(created.body.onboarding.link).toMatch(/\/invite\?token=/);
    const onboarding = await h.http().get('/v1/users/onboarding').set(bearer(admin)).expect(200);
    expect(onboarding.body).toMatchObject({ emailDelivery: 'log', inviteTtlHours: 72 });
    await signIn(LEAD.email, LEAD.password).expect(401);
    const token = h.linkToken(LEAD.email, '/invite');
    await h.http().post('/api/auth/reset-password').send({ token, newPassword: 'aaaaaaaaaaaaaaaa' }).expect(400);
    await h.http().post('/api/auth/reset-password').send({ token, newPassword: LEAD.password }).expect(200);
    await signIn(LEAD.email, LEAD.password).expect(200);
    const list = await h.http().get('/v1/users').set(bearer(admin)).expect(200);
    expect(list.body.find((u: { email: string }) => u.email === LEAD.email).invite.status).toBe('accepted');
    await h.http().post(`/v1/users/${created.body.id}/invite`).set(bearer(admin)).expect(409);
  });

  it('resends an invite (the old link stops working)', async () => {
    const created = await h.http().post('/v1/users').set(bearer(admin)).send({ email: 'exec@ocso.test', name: 'Exec', role: 'SERVICE' }).expect(201);
    const first = h.linkToken('exec@ocso.test', '/invite');
    await h.http().post(`/v1/users/${created.body.id}/invite`).set(bearer(admin)).expect(200);
    const second = h.linkToken('exec@ocso.test', '/invite');
    expect(second).not.toBe(first);
    await h.http().post('/api/auth/reset-password').send({ token: first, newPassword: 'exec password 12345' }).expect(400);
    await h.http().post('/api/auth/reset-password').send({ token: second, newPassword: 'exec password 12345' }).expect(200);
  });

  it('role change and deactivation end every session of the user', async () => {
    const [lead] = await h.db.db.select().from(users).where(eq(users.email, LEAD.email));
    const a = (await signIn(LEAD.email, LEAD.password).expect(200)).headers['set-auth-token'] as string;
    await me(a).expect(200);
    await h.http().patch(`/v1/users/${lead!.id}`).set(bearer(admin)).send({ role: 'SERVICE' }).expect(200);
    await me(a).expect(401);
    const b = (await signIn(LEAD.email, LEAD.password).expect(200)).headers['set-auth-token'] as string;
    await h.http().patch(`/v1/users/${lead!.id}`).set(bearer(admin)).send({ status: 'DISABLED' }).expect(200);
    await me(b).expect(401);
    await signIn(LEAD.email, LEAD.password).expect(401);
    await h.http().patch(`/v1/users/${lead!.id}`).set(bearer(admin)).send({ status: 'ACTIVE', role: 'HEAD' }).expect(200);
  });

  it('password reset by email ends all sessions; change password ends the other ones', async () => {
    const old = (await signIn(LEAD.email, LEAD.password).expect(200)).headers['set-auth-token'] as string;
    await h.http().post('/api/auth/request-password-reset').send({ email: LEAD.email }).expect(200);
    await h.http().post('/api/auth/request-password-reset').send({ email: 'nobody@ocso.test' }).expect(200);
    const token = h.linkToken(LEAD.email, '/reset-password');
    await h.http().post('/api/auth/reset-password').send({ token, newPassword: 'lead new password 1' }).expect(200);
    await me(old).expect(401);
    await signIn(LEAD.email, LEAD.password).expect(401);

    const one = (await signIn(LEAD.email, 'lead new password 1').expect(200)).headers['set-auth-token'] as string;
    const two = (await signIn(LEAD.email, 'lead new password 1').expect(200)).headers['set-auth-token'] as string;
    await h.http().post('/api/auth/change-password').set(bearer(two)).send({ currentPassword: 'wrong password 1', newPassword: LEAD.password }).expect(400);
    const changed = await h.http().post('/api/auth/change-password').set(bearer(two)).send({ currentPassword: 'lead new password 1', newPassword: LEAD.password }).expect(200);
    await me(one).expect(401);
    await me(changed.headers['set-auth-token'] as string).expect(200);
    expect(h.emailsTo(LEAD.email).at(-1)?.kind).toBe('password_changed');
  });

  it('a Tech admin issues a reset link for someone else (returned only because email is not configured)', async () => {
    const [lead] = await h.db.db.select().from(users).where(eq(users.email, LEAD.email));
    const res = await h.http().post(`/v1/users/${lead!.id}/password-reset`).set(bearer(admin)).expect(200);
    expect(res.body.link).toMatch(/\/reset-password\?token=/);
  });
});

describe('idle expiry and long-lived streams', () => {
  it('ends a session after the idle window', async () => {
    const token = (await signIn(ADMIN.email, ADMIN.password).expect(200)).headers['set-auth-token'] as string;
    await h.db.db.update(authSessions).set({ lastActiveAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(authSessions.token, token.split('.')[0]!));
    await me(token).expect(401);
  });

  it('closes the realtime stream once its session is revoked', async () => {
    const token = (await signIn(ADMIN.email, ADMIN.password).expect(200)).headers['set-auth-token'] as string;
    const server = h.app.getHttpServer().listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/v1/realtime/stream`, { headers: { ...bearer(token), accept: 'text/event-stream' } });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let received = '';
      while (!received.includes('event: ready')) received += new TextDecoder().decode((await reader.read()).value);
      await h.http().post('/v1/auth/logout').set(bearer(token)).expect(204);
      const deadline = Date.now() + 5_000;
      let done = false;
      while (!done && Date.now() < deadline) done = (await reader.read()).done;
      expect(done).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
