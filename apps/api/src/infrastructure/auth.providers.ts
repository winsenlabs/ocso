import { createHash } from 'node:crypto';
import { Logger, type Provider } from '@nestjs/common';
import { AuthMailer, AuthPolicyService, RecoveryService, SessionLiveness, type SessionPolicy } from '@ocso/application';
import { createAuthServer, type AuthLog, type AuthServer } from '@ocso/application/auth-server';
import { assertAuthConfig, type ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { EmailSender } from '@ocso/email';
import { AUTH, DB, EMAIL_SENDER, ENV, SESSION_POLICY } from './tokens.js';

/** SESSION_COOKIE_SECURE wins; otherwise secure exactly when the public origin is https. */
export const secureCookies = (env: ApiEnv): boolean => env.SESSION_COOKIE_SECURE ?? env.OCSO_PUBLIC_URL.startsWith('https://');

export const trustedOrigins = (env: ApiEnv): string[] =>
  (env.OCSO_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);

/**
 * Development/test fallback when BETTER_AUTH_SECRET is unset: stable per
 * database (sessions survive restarts) and never used in production, where
 * assertAuthConfig refuses to start without a real secret.
 */
function authSecret(env: ApiEnv, logger: Logger): string {
  assertAuthConfig(env);
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  logger.warn('BETTER_AUTH_SECRET is not set: using a development secret derived from DATABASE_URL (never do this in production)');
  return createHash('sha256').update(`ocso-dev-auth-secret:${env.DATABASE_URL}`).digest('base64url');
}

function authLog(logger: Logger): AuthLog {
  return (level, message, err) => {
    const detail = err instanceof Error ? `${message}: ${err.message}` : message;
    if (level === 'error') logger.error(detail);
    else if (level === 'warn') logger.warn(detail);
    else if (level === 'info') logger.log(detail);
    else logger.debug(detail);
  };
}

/** Authentication bindings (ADR-025): Better Auth server, its email + policy collaborators. */
export const AUTH_PROVIDERS: Provider[] = [
  {
    provide: SESSION_POLICY,
    inject: [ENV],
    useFactory: (env: ApiEnv): SessionPolicy => ({ idleMinutes: env.SESSION_IDLE_MINUTES, absoluteHours: env.SESSION_ABSOLUTE_HOURS, maxFailures: 8, failureWindowMinutes: 15 }),
  },
  { provide: AuthPolicyService, inject: [DB], useFactory: (db: Db) => new AuthPolicyService(db) },
  {
    provide: AuthMailer,
    inject: [DB, EMAIL_SENDER, ENV],
    useFactory: (db: Db, sender: EmailSender, env: ApiEnv) => {
      const logger = new Logger('AuthMail');
      return new AuthMailer({ db, sender, publicUrl: env.OCSO_PUBLIC_URL, onError: (kind, err) => logger.warn(`${kind} email not delivered: ${err instanceof Error ? err.message : 'unknown error'}`) });
    },
  },
  {
    provide: AUTH,
    inject: [ENV, DB, AuthMailer, AuthPolicyService, SESSION_POLICY],
    useFactory: (env: ApiEnv, db: Db, mailer: AuthMailer, authPolicy: AuthPolicyService, session: SessionPolicy): AuthServer => {
      const logger = new Logger('Auth');
      return createAuthServer(
        {
          publicUrl: env.OCSO_PUBLIC_URL,
          secret: authSecret(env, logger),
          secureCookies: secureCookies(env),
          trustedOrigins: trustedOrigins(env),
          session,
          rateLimit: env.OCSO_AUTH_RATE_LIMIT ?? true,
        },
        { db, mailer, authPolicy, log: authLog(logger) },
      );
    },
  },
  {
    provide: SessionLiveness,
    inject: [DB, SESSION_POLICY, AuthPolicyService],
    useFactory: (db: Db, policy: SessionPolicy, authPolicy: AuthPolicyService) => new SessionLiveness(db, policy, authPolicy),
  },
  { provide: RecoveryService, inject: [DB, ENV], useFactory: (db: Db, env: ApiEnv) => new RecoveryService(db, env.OCSO_RECOVERY_TOKEN) },
];

export const AUTH_EXPORTS = [SESSION_POLICY, AuthPolicyService, AuthMailer, AUTH, SessionLiveness, RecoveryService];
