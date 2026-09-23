import { and, eq, gt, sql } from 'drizzle-orm';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { loginAttempts, users, uuidv7, type Db } from '@ocso/db';
import { mfaPending, type AuthPolicyService } from '../auth-policy.js';
import type { AuthMailer } from '../auth-mailer.js';
import { passwordProblems } from '../password.js';
import { deleteSession, findLiveSession, isIdleExpired, touchSession, type SessionPolicy } from '../sessions.js';
import type { AuthAudit } from './audit.js';
import { AUDITED_ENDPOINTS, HTTP_AUTH_ENDPOINTS, PENDING_MFA_ENDPOINTS, SIGN_IN_METHODS } from './endpoints.js';
import { clientIpOf, sessionTokenOf } from './request.js';

export interface PolicyPluginDeps {
  db: Db;
  policy: SessionPolicy;
  authPolicy: AuthPolicyService;
  audit: AuthAudit;
  mailer: AuthMailer;
}

/** An address may fail this many times the per-account limit (shared NAT/offices) before it is paused. */
const IP_FAILURE_MULTIPLIER = 5;
/** Session-bearing requests that skip the idle/MFA gate (leaving must always work). */
const UNGATED = new Set(['/sign-out']);

const tooManyAttempts = () => APIError.from('TOO_MANY_REQUESTS', { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed sign-in attempts. Try again later.' });

/**
 * OCSO policy on top of Better Auth (ADR-025), listed last so its after-hooks
 * see the final outcome (e.g. after the two-factor plugin replaced a password
 * session with a challenge):
 * - HTTP allowlist (endpoints.ts): anything else is 404 over HTTP;
 * - idle timeout (auth_sessions.last_active_at) and "require MFA for roles";
 * - per-account and per-address sign-in throttling (login_attempts);
 * - password policy on reset/change; change-password always ends other sessions;
 * - audit of sign-ins and account-security changes.
 */
export function ocsoPolicy(deps: PolicyPluginDeps): BetterAuthPlugin {
  const { db, policy, authPolicy, audit } = deps;

  const gate = createAuthMiddleware(async (ctx) => {
    const path = ctx.path ?? '';
    if (ctx.request && !HTTP_AUTH_ENDPOINTS.has(path)) throw APIError.from('NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found' });

    if (path === '/sign-in/email') await assertNotThrottled(db, policy, String((ctx.body as { email?: unknown } | undefined)?.email ?? ''), clientIpOf(ctx));
    if (path === '/reset-password' || path === '/change-password') {
      const problems = passwordProblems(String((ctx.body as { newPassword?: unknown } | undefined)?.newPassword ?? ''));
      if (problems.length) throw APIError.from('BAD_REQUEST', { code: 'PASSWORD_TOO_WEAK', message: `Password ${problems.join(', ')}` });
    }

    const token = UNGATED.has(path) ? null : sessionTokenOf(ctx, ctx.context.authCookies.sessionToken.name);
    if (token) {
      const now = new Date();
      const live = await findLiveSession(db, { token }, now);
      if (live) {
        if (isIdleExpired(live, policy, now)) {
          await deleteSession(db, live.sessionId);
          throw APIError.from('UNAUTHORIZED', { code: 'SESSION_EXPIRED', message: 'Your session ended after a period of inactivity. Sign in again.' });
        }
        const mfa = await authPolicy.mfaState(live.role, live.authMethod, live.twoFactorEnabled, live.permissions);
        if (mfaPending(mfa) && !PENDING_MFA_ENDPOINTS.has(path)) {
          throw APIError.from('FORBIDDEN', { code: 'MFA_ENROLLMENT_REQUIRED', message: 'Set up two-factor authentication to continue' });
        }
        if (path === '/two-factor/disable' && mfa.required) {
          throw APIError.from('FORBIDDEN', { code: 'MFA_REQUIRED_BY_POLICY', message: 'Your role requires two-factor authentication' });
        }
        await touchSession(db, live, now);
      }
    }
    if (path === '/change-password') return { context: { body: { ...(ctx.body as object), revokeOtherSessions: true } } };
    return;
  });

  const record = createAuthMiddleware(async (ctx) => {
    const path = ctx.path ?? '';
    const failed = isAPIError(ctx.context.returned) && (ctx.context.returned.statusCode ?? 500) >= 400;
    const newSession = ctx.context.newSession;
    const priorSession = ctx.context.session;

    if (path === '/sign-in/email') {
      const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? '').slice(0, 320);
      const throttled = failed && (ctx.context.returned as APIError).statusCode === 429;
      if (email && !throttled) await db.insert(loginAttempts).values({ id: uuidv7(), email, ip: clientIpOf(ctx) ?? null, success: !failed });
      if (failed && !throttled) {
        const [user] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1);
        if (user) await audit.asUser(user.id, ctx, { action: 'auth.login_failed', summary: 'failed sign-in (wrong password or account unavailable)' });
        else await audit.asSystem(ctx, { action: 'auth.login_failed', targetType: 'user', summary: 'failed sign-in for an unknown account' });
      }
    }

    const method = SIGN_IN_METHODS[path];
    if (method && newSession && !(path === '/two-factor/verify-totp' && priorSession?.session)) {
      const userId = newSession.user.id;
      await db
        .update(users)
        .set({
          lastLoginAt: new Date(),
          // SSO and passkeys prove control of the account: an outstanding invite counts as accepted.
          ...(method === 'sso' ? { emailVerified: true, inviteExpiresAt: null } : {}),
        })
        .where(eq(users.id, userId));
      await audit.asUser(userId, ctx, { action: 'auth.login', summary: `signed in (${method === 'mfa' ? 'password + second factor' : method})`, sessionId: newSession.session.id });
      return;
    }

    if (failed && (path === '/two-factor/verify-totp' || path === '/two-factor/verify-backup-code') && !priorSession?.session) {
      await audit.asSystem(ctx, { action: 'auth.mfa_failed', targetType: 'user', summary: 'failed second-factor verification during sign-in' });
      return;
    }

    const user = priorSession?.user;
    if (failed || !user) return;
    if (path === '/two-factor/verify-totp') {
      await audit.asUser(user.id, ctx, { action: 'auth.mfa_enrolled', summary: 'enrolled an authenticator app' });
      return;
    }
    const audited = AUDITED_ENDPOINTS[path];
    if (audited) await audit.asUser(user.id, ctx, { action: audited.action, summary: audited.summary });
    if (path === '/change-password') await deps.mailer.sendPasswordChanged({ to: user.email, name: user.name, changedAt: new Date() });
  });

  return {
    id: 'ocso-policy',
    hooks: {
      before: [{ matcher: () => true, handler: gate }],
      after: [{ matcher: () => true, handler: record }],
    },
  };
}

async function assertNotThrottled(db: Db, policy: SessionPolicy, email: string, ip: string | undefined): Promise<void> {
  const since = new Date(Date.now() - policy.failureWindowMinutes * 60_000);
  // Credential stuffing spreads failures across many accounts from one address.
  if (ip) {
    const [fromIp] = await db
      .select({ failures: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gt(loginAttempts.occurredAt, since)));
    if ((fromIp?.failures ?? 0) >= policy.maxFailures * IP_FAILURE_MULTIPLIER) throw tooManyAttempts();
  }
  if (!email) return;
  const [row] = await db
    .select({ failures: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(sql`lower(${loginAttempts.email}) = lower(${email})`, eq(loginAttempts.success, false), gt(loginAttempts.occurredAt, since)));
  if ((row?.failures ?? 0) >= policy.maxFailures) throw tooManyAttempts();
}
