import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { authSessions, users } from '@ocso/db';
import { LogEmailSender } from '@ocso/email';
import { AuthMailer, AuthPolicyService, DEFAULT_SESSION_POLICY, SetupService, UserService, type ActorContext } from '../src/index.js';
import { HTTP_AUTH_ENDPOINTS, createAuthServer, type AuthServer } from '../src/identity/auth/index.js';

const ORIGIN = 'http://localhost:3999';
const TOKEN = 'setup-token-0123456789';
const ADMIN = { email: 'Tejas@Meridian.test', password: 'correct horse battery staple' };

let t: TestDatabase;
let auth: AuthServer;
let sender: LogEmailSender;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocso-client-ip': '203.0.113.9', ...headers }, body: JSON.stringify(body) }));
const signIn = (email: string, password: string, ip = '203.0.113.9') => post('/sign-in/email', { email, password }, { 'x-ocso-client-ip': ip });
const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  t = await createTestDatabase();
  sender = new LogEmailSender('OCSO <no-reply@ocso.test>');
  const mailer = new AuthMailer({ db: t.db, sender, publicUrl: ORIGIN });
  auth = createAuthServer(
    { publicUrl: ORIGIN, secret: 'test-secret-0123456789-0123456789-abcdef', secureCookies: false, session: { ...DEFAULT_SESSION_POLICY, maxFailures: 3 } },
    { db: t.db, mailer, authPolicy: new AuthPolicyService(t.db), log: () => {} },
  );
  await new SetupService(t.db, TOKEN).complete({ setupToken: TOKEN, orgName: 'Meridian Bank', adminName: 'Tejas', adminEmail: ADMIN.email, adminPassword: ADMIN.password, timezone: 'UTC' }, 'c');
});
afterAll(async () => {
  await t?.drop();
});

describe('Better Auth server (ADR-025)', () => {
  it('signs in with the setup password (OCSO scrypt) and returns a bearer token the session check accepts', async () => {
    const res = await signIn('tejas@meridian.test', ADMIN.password);
    expect(res.status).toBe(200);
    const token = res.headers.get('set-auth-token');
    expect(token).toBeTruthy();
    expect(res.headers.get('set-cookie')).toMatch(/^ocso\.session_token=/);
    const session = await auth.getSession(bearer(token!));
    expect(session?.user.email).toBe('tejas@meridian.test');
    expect(session?.session.authMethod).toBe('password');
    const [user] = await t.db.select({ lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.id, session!.user.id));
    expect(user?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('rejects a wrong password and throttles the account after repeated failures', async () => {
    for (let i = 0; i < 3; i++) expect((await signIn('tejas@meridian.test', 'wrong password 123')).status).toBe(401);
    const throttled = await signIn('tejas@meridian.test', ADMIN.password);
    expect(throttled.status).toBe(429);
    await t.db.execute(sql`DELETE FROM login_attempts`);
  });

  it('closes every endpoint that is not on the HTTP allowlist', async () => {
    expect((await post('/sign-up/email', { email: 'x@y.test', password: 'long enough password', name: 'X' })).status).toBe(404);
    expect((await post('/sso/register', { providerId: 'x' })).status).toBe(404);
    for (const path of HTTP_AUTH_ENDPOINTS) expect(auth.endpointPaths()).toContain(path);
  });

  it('ends idle sessions', async () => {
    const token = (await signIn('tejas@meridian.test', ADMIN.password)).headers.get('set-auth-token')!;
    await t.db.update(authSessions).set({ lastActiveAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(authSessions.token, token.split('.')[0]!));
    expect(await auth.getSession(bearer(token))).toBeNull();
    const [row] = await t.db.select().from(authSessions).where(eq(authSessions.token, token.split('.')[0]!));
    expect(row).toBeUndefined();
  });

  it('accepts an invite through reset-password and signs in with the new password', async () => {
    const [admin] = await t.db.select().from(users).where(eq(users.email, 'tejas@meridian.test'));
    const actor: ActorContext = { principal: { userId: admin!.id, role: 'PLATFORM_TECH_ADMIN', displayName: 'Tejas', teamIds: [], via: 'UI' }, correlationId: 'c' };
    const mailer = new AuthMailer({ db: t.db, sender, publicUrl: ORIGIN });
    const created = await new UserService(t.db, { mailer, allowInitialPasswords: false }).create(actor, { email: 'Lead@Meridian.test', name: 'Lead', role: 'CS_LEAD' });
    expect(created.invite.status).toBe('pending');
    const mail = sender.sent.at(-1)!;
    expect(mail.to).toBe('lead@meridian.test');
    const link = /http:\/\/localhost:3999\/invite\?token=([\w-]+)/.exec(mail.text)?.[1];
    expect(link).toBeTruthy();
    expect((await post('/reset-password', { token: link, newPassword: 'aaaaaaaaaaaaaaaa' })).status).toBe(400);
    const accepted = await post('/reset-password', { token: link, newPassword: 'lead password 12345' });
    expect(accepted.status).toBe(200);
    expect((await post('/reset-password', { token: link, newPassword: 'lead password 12345' })).status).toBe(400);
    const res = await signIn('lead@meridian.test', 'lead password 12345');
    expect(res.status).toBe(200);
    const [lead] = await t.db.select().from(users).where(eq(users.email, 'lead@meridian.test'));
    expect(lead?.emailVerified).toBe(true);
    expect(lead?.inviteExpiresAt).toBeNull();
  });
});
