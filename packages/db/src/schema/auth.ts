import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';

/**
 * Better Auth storage (ADR-025). Better Auth addresses these tables through the
 * Drizzle adapter by their export name (its `modelName`) and each column by its
 * property name, so property names follow Better Auth's field names. `users`
 * (identity.ts) is Better Auth's user model. Columns Better Auth never writes
 * are nullable or have defaults (its schema check requires that).
 */

/** Browser/API sessions. The cookie carries `token` + HMAC; `token` is unique. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    token: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Absolute expiry: created + SESSION_ABSOLUTE_HOURS (refresh disabled). */
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text(),
    userAgent: text(),
    /** OCSO idle policy: bumped at most once a minute by authenticated requests. */
    lastActiveAt: ts('last_active_at').notNull().defaultNow(),
    /** How the session was established: password | mfa | passkey | sso | recovery. */
    authMethod: text().notNull().default('password'),
  },
  (t) => [uniqueIndex('auth_sessions_token_uq').on(t.token), index('auth_sessions_user_idx').on(t.userId)],
);

/** Credential (providerId = 'credential', password = OCSO scrypt hash) and SSO accounts. */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: id(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('auth_accounts_provider_account_uq').on(t.providerId, t.accountId), index('auth_accounts_user_idx').on(t.userId)],
);

/** One-time values: invite / password-reset tokens, 2FA challenges, OAuth state, WebAuthn challenges. */
export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auth_verifications_identifier_idx').on(t.identifier), index('auth_verifications_expires_idx').on(t.expiresAt)],
);

/** TOTP secret and backup codes (both encrypted with BETTER_AUTH_SECRET). */
export const authTwoFactors = pgTable(
  'auth_two_factors',
  {
    id: id(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    verified: boolean().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: ts('locked_until'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_two_factors_user_uq').on(t.userId), index('auth_two_factors_secret_idx').on(t.secret)],
);

/** WebAuthn credentials (rpID = host of OCSO_PUBLIC_URL). */
export const authPasskeys = pgTable(
  'auth_passkeys',
  {
    id: id(),
    name: text(),
    publicKey: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    createdAt: ts('created_at').defaultNow(),
    aaguid: text(),
  },
  (t) => [index('auth_passkeys_user_idx').on(t.userId), uniqueIndex('auth_passkeys_credential_uq').on(t.credentialID)],
);

/**
 * SSO identity providers (OIDC or SAML 2.0), managed by the Tech Admin through
 * OCSO's API. `domain` is a comma-separated list of email domains.
 */
export const authSsoProviders = pgTable(
  'auth_sso_providers',
  {
    id: id(),
    issuer: text().notNull(),
    oidcConfig: text(),
    samlConfig: text(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    providerId: text().notNull(),
    organizationId: text(),
    domain: text().notNull(),
    /** Display name on the sign-in page. */
    name: text().notNull().default('Single sign-on'),
    /** Create unknown users (as CS Exec) on first sign-in; default: invited users only. */
    autoProvision: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('auth_sso_providers_provider_uq').on(t.providerId)],
);

/** Better Auth rate limiter (database storage: shared by every API instance). */
export const authRateLimits = pgTable(
  'auth_rate_limits',
  {
    id: id(),
    key: text().notNull(),
    count: integer().notNull(),
    lastRequest: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('auth_rate_limits_key_uq').on(t.key), index('auth_rate_limits_last_idx').on(t.lastRequest)],
);

/** Singleton (id = 1): authentication policy the Tech Admin controls in Settings. */
export const authPolicy = pgTable('auth_policy', {
  id: smallint().primaryKey().default(1),
  /** Roles that must use a second factor (TOTP, passkey or SSO) to reach the app. */
  requireMfaRoles: text().array().notNull().default(sql`'{}'::text[]`),
  /** SHA-256 of the last OCSO_RECOVERY_TOKEN used, so one token works once. */
  recoveryTokenUsedHash: text(),
  updatedAt: updatedAt(),
  updatedBy: uuid(),
});
