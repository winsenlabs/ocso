import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError, validation } from '@ocso/domain';
import { authPolicy, authTwoFactors, users, type Db } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { revokeUserSessions, setPasswordCredential } from './credentials.js';
import { hashPassword, passwordProblems } from './password.js';

export const RecoveryInput = z.object({
  recoveryToken: z.string().min(32).max(512),
  email: z.email().max(320),
  newPassword: z.string().min(12).max(256),
});
export type RecoveryInput = z.infer<typeof RecoveryInput>;

/** Minimum length of OCSO_RECOVERY_TOKEN: it is the only thing guarding this path. */
export const MIN_RECOVERY_TOKEN_LENGTH = 32;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const authError = (code: string, message: string) => new DomainError('authentication', code, message);

/**
 * Break-glass recovery (ADR-025) for a deployment whose Tech Admins are locked
 * out (lost authenticator and backup codes, broken IdP, no email delivery).
 * Bootstrap-only: works only while the operator sets OCSO_RECOVERY_TOKEN, and
 * each token value works once. It resets one active Platform Tech Admin's
 * password, removes their authenticator (they re-enroll at next sign-in when
 * MFA is required) and ends their sessions. Audited.
 */
export class RecoveryService {
  constructor(
    private readonly db: Db,
    private readonly recoveryToken: string | undefined,
  ) {}

  get enabled(): boolean {
    return Boolean(this.recoveryToken && this.recoveryToken.length >= MIN_RECOVERY_TOKEN_LENGTH);
  }

  async recover(input: RecoveryInput, meta: { correlationId: string; ip?: string | undefined }): Promise<void> {
    if (!this.enabled || !this.recoveryToken) throw authError('recovery_disabled', 'Account recovery is not enabled on this deployment');
    const given = Buffer.from(sha256(input.recoveryToken));
    const expected = Buffer.from(sha256(this.recoveryToken));
    if (!timingSafeEqual(given, expected)) throw authError('invalid_recovery_token', 'Recovery token is not valid');
    const problems = passwordProblems(input.newPassword);
    if (problems.length) throw validation('weak_password', `Password ${problems.join(', ')}`);
    const hash = await hashPassword(input.newPassword);
    const tokenHash = sha256(this.recoveryToken);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ocso:recovery'))`);
      const [policy] = await tx.select({ used: authPolicy.recoveryTokenUsedHash }).from(authPolicy).where(eq(authPolicy.id, 1));
      if (policy?.used === tokenHash) throw authError('recovery_token_used', 'This recovery token was already used. Set a new OCSO_RECOVERY_TOKEN.');
      const [admin] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(sql`lower(${users.email}) = lower(${input.email})`, eq(users.role, 'PLATFORM_TECH_ADMIN'), eq(users.status, 'ACTIVE')))
        .limit(1);
      if (!admin) throw authError('invalid_recovery_target', 'No active Platform Tech Admin has this email');
      await setPasswordCredential(tx, admin.id, hash);
      await tx.delete(authTwoFactors).where(eq(authTwoFactors.userId, admin.id));
      await tx.update(users).set({ twoFactorEnabled: false, emailVerified: true, updatedAt: new Date() }).where(eq(users.id, admin.id));
      const ended = await revokeUserSessions(tx, admin.id);
      await tx
        .insert(authPolicy)
        .values({ id: 1, recoveryTokenUsedHash: tokenHash })
        .onConflictDoUpdate({ target: authPolicy.id, set: { recoveryTokenUsedHash: tokenHash, updatedAt: new Date() } });
      await recordAudit(tx, { principal: null, system: { kind: 'SYSTEM', id: 'recovery', name: 'Break-glass recovery' }, correlationId: meta.correlationId, ip: meta.ip }, {
        action: 'auth.recovery',
        targetType: 'user',
        targetId: admin.id,
        summary: `Break-glass recovery reset the password of ${admin.email}, removed their authenticator and ended ${ended} session(s)`,
      });
    });
  }
}
