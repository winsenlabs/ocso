import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { authAccounts, authSessions, authVerifications, uuidv7, type DbOrTx } from '@ocso/db';

/**
 * Direct reads/writes of Better Auth's credential data (ADR-025) for the use
 * cases OCSO owns transactionally with its own audit trail: first-run setup,
 * invites, admin-set passwords, role changes and break-glass recovery. Every
 * row matches what Better Auth itself writes, so its endpoints (sign-in,
 * reset-password, sessions) work on them unchanged.
 */

/** Better Auth's provider id for email + password accounts. */
export const CREDENTIAL_PROVIDER = 'credential';

/** Better Auth's verification identifier prefix consumed by POST /reset-password. */
const RESET_PREFIX = 'reset-password:';

/**
 * Identifiers are stored hashed (`verification.storeIdentifier: 'hashed'`):
 * base64url(SHA-256(identifier)) without padding, exactly like Better Auth.
 */
export function hashedIdentifier(identifier: string): string {
  return createHash('sha256').update(identifier).digest('base64url');
}

/** Create or replace the user's password (an OCSO scrypt hash). */
export async function setPasswordCredential(tx: DbOrTx, userId: string, passwordHash: string, now = new Date()): Promise<void> {
  await tx
    .insert(authAccounts)
    .values({ id: uuidv7(), accountId: userId, providerId: CREDENTIAL_PROVIDER, userId, password: passwordHash, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [authAccounts.providerId, authAccounts.accountId], set: { password: passwordHash, updatedAt: now } });
}

export async function hasPasswordCredential(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ password: authAccounts.password })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, CREDENTIAL_PROVIDER)))
    .limit(1);
  return Boolean(row?.password);
}

export interface PasswordToken {
  token: string;
  expiresAt: Date;
}

/**
 * A single-use set-password token (invite or admin-initiated reset). Better
 * Auth's POST /reset-password consumes it, creating the credential account
 * when the user has none yet.
 */
export async function createPasswordToken(tx: DbOrTx, userId: string, ttlSeconds: number, now = new Date()): Promise<PasswordToken> {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await tx.insert(authVerifications).values({
    id: uuidv7(),
    identifier: hashedIdentifier(`${RESET_PREFIX}${token}`),
    value: userId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  return { token, expiresAt };
}

/**
 * Invalidate outstanding one-time values of a user who has no credentials yet
 * (a resent invite replaces the previous link). Verification rows store the
 * user id as their value.
 */
export async function deleteUserVerifications(tx: DbOrTx, userId: string): Promise<void> {
  await tx.delete(authVerifications).where(eq(authVerifications.value, userId));
}

/** End every session of a user (role change, deactivation, recovery). Returns how many ended. */
export async function revokeUserSessions(tx: DbOrTx, userId: string): Promise<number> {
  const rows = await tx.delete(authSessions).where(eq(authSessions.userId, userId)).returning({ id: authSessions.id });
  return rows.length;
}
