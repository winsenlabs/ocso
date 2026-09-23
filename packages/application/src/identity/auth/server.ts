import { eq, sql } from 'drizzle-orm';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth';
import { APIError, isAPIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins/bearer';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { passkey } from '@better-auth/passkey';
import { sso } from '@better-auth/sso';
import {
  authAccounts,
  authPasskeys,
  authRateLimits,
  authSessions,
  authSsoProviders,
  authTwoFactors,
  authVerifications,
  users,
  uuidv7,
  type Db,
} from '@ocso/db';
import type { AuthPolicyService } from '../auth-policy.js';
import type { AuthMailer } from '../auth-mailer.js';
import { hashPassword, verifyPassword } from '../password.js';
import { SIGN_IN_METHODS } from './endpoints.js';
import { AuthAudit, type AuthLog } from './audit.js';
import { ocsoPolicy } from './policy-plugin.js';
import { CLIENT_IP_HEADER } from './request.js';
import { ssoUserResolver } from './sso-resolver.js';
import type { SessionPolicy } from '../sessions.js';
import type { AuthServer } from './types.js';

export type { AuthServer, AuthSession, SsoRegistration } from './types.js';

export interface AuthServerConfig {
  /** OCSO_PUBLIC_URL: the origin browsers use; Better Auth is served at <origin>/api/auth. */
  publicUrl: string;
  /** BETTER_AUTH_SECRET (≥ 32 chars): signs cookies, encrypts TOTP secrets and backup codes. */
  secret: string;
  /** Secure cookies (`__Secure-` prefix); SESSION_COOKIE_SECURE semantics. */
  secureCookies: boolean;
  /** Extra trusted origins, e.g. an internal (non-public) IdP. */
  trustedOrigins?: readonly string[] | undefined;
  session: SessionPolicy;
  /** Better Auth's rate limiter (database storage). On by default. */
  rateLimit?: boolean | undefined;
}

export interface AuthServerDeps {
  db: Db;
  mailer: AuthMailer;
  authPolicy: AuthPolicyService;
  log: AuthLog;
}

/** Password reset links from "Forgot password?" live this long (invites use UserService's TTL). */
export const RESET_TOKEN_TTL_SECONDS = 3600;
export const COOKIE_PREFIX = 'ocso';

/**
 * A per-address limit. Without a trusted client address (OCSO_TRUSTED_PROXY_HOPS=0) every browser
 * shares one bucket, so the budget grows to fit a whole shift signing in; per-account throttling
 * (login_attempts) still protects each account.
 */
const SHARED_BUCKET_FACTOR = 20;
const perAddress = (window: number, max: number) => (request: Request) =>
  request.headers.get(CLIENT_IP_HEADER) ? { window, max } : { window, max: max * SHARED_BUCKET_FACTOR };

/** The Drizzle tables Better Auth addresses, keyed by model name. */
const SCHEMA = { users, authSessions, authAccounts, authVerifications, authTwoFactors, authPasskeys, authSsoProviders, authRateLimits };

/**
 * OCSO's Better Auth server (ADR-025), framework-free: the API mounts
 * `auth.handler` at /api/auth and its guard calls `auth.api.getSession`.
 * Authorization stays OCSO's (roles → permissions, deny-by-default guard).
 */
export function createAuthServer(config: AuthServerConfig, deps: AuthServerDeps): AuthServer {
  const auth = betterAuth(authOptions(config, deps));
  return {
    handler: (request) => auth.handler(request),
    async getSession(headers) {
      try {
        const result = await auth.api.getSession({ headers });
        if (!result) return null;
        const { session, user } = result;
        return {
          session: { id: session.id, token: session.token, userId: session.userId, createdAt: session.createdAt, expiresAt: session.expiresAt, authMethod: session.authMethod ?? 'password' },
          user: { id: user.id, email: user.email, name: user.name, twoFactorEnabled: Boolean(user.twoFactorEnabled) },
        };
      } catch (err) {
        if (isAPIError(err) && err.statusCode < 500) return null;
        throw err;
      }
    },
    async signOut(headers) {
      await auth.api.signOut({ headers }).catch((err: unknown) => {
        if (!(isAPIError(err) && err.statusCode < 500)) throw err;
      });
    },
    async registerSsoProvider(headers, body) {
      await auth.api.registerSSOProvider({ headers, body });
    },
    async deleteSsoProvider(headers, providerId) {
      await auth.api.deleteSSOProvider({ headers, body: { providerId } });
    },
    endpointPaths: () => Object.values(auth.api).map((endpoint) => (endpoint as { path?: string }).path ?? '').filter(Boolean),
  };
}

function authOptions(config: AuthServerConfig, deps: AuthServerDeps) {
  const { db, mailer, log } = deps;
  const audit = new AuthAudit(db, log);
  const origin = new URL(config.publicUrl).origin;

  return {
    appName: 'OCSO',
    baseURL: origin,
    basePath: '/api/auth',
    secret: config.secret,
    telemetry: { enabled: false },
    logger: { level: 'warn', log: (level, message, ...args) => log(level, `better-auth: ${message}`, args[0]) },
    database: drizzleAdapter(db, { provider: 'pg', schema: SCHEMA, transaction: true }),
    trustedOrigins: [origin, ...(config.trustedOrigins ?? [])],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(password, hash) },
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }, request) => {
        await mailer.sendPasswordReset({ to: user.email, name: user.name, token, expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000) });
        await audit.asUser(user.id, { request }, { action: 'auth.password_reset_requested', summary: 'requested a password reset email' });
      },
      onPasswordReset: async ({ user }, request) => {
        const [row] = await db.select({ inviteExpiresAt: users.inviteExpiresAt }).from(users).where(eq(users.id, user.id));
        const invited = Boolean(row?.inviteExpiresAt);
        await db.update(users).set({ emailVerified: true, inviteExpiresAt: null, updatedAt: new Date() }).where(eq(users.id, user.id));
        await audit.asUser(user.id, { request }, invited
          ? { action: 'user.invite_accepted', summary: 'accepted their invite and set a password' }
          : { action: 'auth.password_reset', summary: 'reset their password with an emailed link; all sessions ended' });
      },
    },
    user: {
      modelName: 'users',
      additionalFields: {
        role: { type: 'string', required: false, input: false, defaultValue: 'SERVICE' },
        status: { type: 'string', required: false, input: false, defaultValue: 'ACTIVE' },
      },
    },
    session: {
      modelName: 'authSessions',
      // Absolute lifetime; the idle window is OCSO's (policy plugin). No sliding refresh, so the
      // cookie's Max-Age and the row's expiry agree and nothing extends a session past it.
      expiresIn: config.session.absoluteHours * 3600,
      disableSessionRefresh: true,
      freshAge: config.session.absoluteHours * 3600,
      additionalFields: { authMethod: { type: 'string', required: false, input: false } },
    },
    account: { modelName: 'authAccounts', accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false } },
    verification: { modelName: 'authVerifications', storeIdentifier: 'hashed' },
    rateLimit: {
      enabled: config.rateLimit ?? true,
      storage: 'database',
      modelName: 'authRateLimits',
      window: 60,
      max: 300,
      customRules: {
        '/sign-in/email': perAddress(60, 30),
        '/sign-in/sso': perAddress(60, 30),
        '/request-password-reset': { window: 300, max: 5 },
        '/reset-password': { window: 300, max: 10 },
        '/change-password': { window: 300, max: 10 },
        '/two-factor/*': perAddress(60, 15),
        '/passkey/*': perAddress(60, 30),
      },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: config.secureCookies,
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => uuidv7() },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // Through Better Auth's adapter: an SSO-provisioned user exists only inside its open transaction.
            const user = ctx
              ? ((await ctx.context.internalAdapter.findUserById(session.userId)) as { status?: string } | null)
              : (await db.select({ status: users.status }).from(users).where(eq(users.id, session.userId)).limit(1))[0];
            if (user?.status !== 'ACTIVE') throw APIError.from('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
            const inherited = typeof session['authMethod'] === 'string' ? session['authMethod'] : (ctx?.context.session?.session as { authMethod?: string } | undefined)?.authMethod;
            const method = SIGN_IN_METHODS[ctx?.path ?? ''] ?? inherited ?? 'password';
            return { data: { ...session, authMethod: method } };
          },
        },
        delete: {
          after: async (session, ctx) => {
            if (ctx?.path === '/sign-out') await audit.asUser(session.userId, ctx, { action: 'auth.logout', summary: 'signed out' });
          },
        },
      },
      user: {
        create: {
          // Only SSO auto-provisioning creates users through Better Auth (sign-up is off).
          before: async (user) => ({ data: { ...user, email: user.email.toLowerCase(), role: 'SERVICE', status: 'ACTIVE', emailVerified: true } }),
          after: async (user, ctx) => {
            await audit.asSystem(ctx ?? {}, { action: 'user.create', targetType: 'user', targetId: user.id, summary: `Created SERVICE ${user.email} on first SSO sign-in (auto-provisioning)` });
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: 'OCSO',
        allowPasswordless: true,
        twoFactorCookieMaxAge: 600,
        backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: 'encrypted' },
        schema: { twoFactor: { modelName: 'authTwoFactors' } },
      }),
      passkey({
        rpID: new URL(origin).hostname,
        rpName: 'OCSO',
        origin,
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        schema: { passkey: { modelName: 'authPasskeys' } },
      }),
      sso({
        modelName: 'authSsoProviders',
        resolveUser: ssoUserResolver(db, audit),
        providersLimit: 100,
        disableImplicitSignUp: false,
        trustEmailVerified: false,
        saml: { enableInResponseToValidation: true, allowIdpInitiated: false, requireTimestamps: true, algorithms: { onDeprecated: 'reject' } },
        schema: {
          ssoProvider: {
            additionalFields: {
              name: { type: 'string', required: false, defaultValue: 'Single sign-on' },
              autoProvision: { type: 'boolean', required: false, defaultValue: false },
            },
          },
        },
      }),
      // After two-factor: a sign-in that turns into a 2FA challenge must not expose the discarded session token.
      bearer({ requireSignature: true }),
      // Last, so its after-hooks see the final outcome of every other plugin.
      ocsoPolicy({ db, policy: config.session, authPolicy: deps.authPolicy, audit, mailer }),
    ],
  } satisfies BetterAuthOptions;
}

/** Count of active Better Auth sessions (for tests and diagnostics). */
export async function countSessions(db: Db, userId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(authSessions).where(eq(authSessions.userId, userId));
  return row?.n ?? 0;
}
