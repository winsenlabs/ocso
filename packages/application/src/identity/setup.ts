import { randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DomainError, validation } from '@ocso/domain';
import { deploymentSettings, users, uuidv7, type Db } from '@ocso/db';
import { z } from 'zod';
import { seedDefaultAlertRules } from '../alerts/seed.js';
import { recordInstalledApproval } from '../approvals/installed.js';
import { recordAudit } from '../audit/audit.js';
import { setPasswordCredential } from './credentials.js';
import { hashPassword, passwordProblems } from './password.js';

export const SetupInput = z.object({
  setupToken: z.string().min(16).max(200),
  orgName: z.string().trim().min(1).max(200),
  adminName: z.string().trim().min(1).max(200),
  adminEmail: z.email().max(320),
  adminPassword: z.string().min(12).max(256),
  timezone: z.string().max(64).default('UTC'),
});
export type SetupInput = z.infer<typeof SetupInput>;

/**
 * First-run setup (ADR-010, ADR-025): while no user exists, the web /setup page
 * creates the first Tech admin (a Better Auth user with a credential
 * account), guarded by a one-time setup token. No CLI.
 */
export class SetupService {
  constructor(
    private readonly db: Db,
    private readonly setupToken: string,
  ) {}

  async isSetupRequired(): Promise<boolean> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(users);
    return (row?.n ?? 0) === 0;
  }

  async complete(input: SetupInput, correlationId: string): Promise<{ userId: string }> {
    const given = Buffer.from(input.setupToken);
    const expected = Buffer.from(this.setupToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new DomainError('authentication', 'invalid_setup_token', 'Setup token is not valid');
    }
    const problems = passwordProblems(input.adminPassword);
    if (problems.length) throw validation('weak_password', `Password ${problems.join(', ')}`);
    const passwordHash = await hashPassword(input.adminPassword);
    const userId = uuidv7();
    await this.db.transaction(async (tx) => {
      // Serialize concurrent setup attempts; only the first one wins.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ocso:setup'))`);
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
      if ((row?.n ?? 0) > 0) throw new DomainError('conflict', 'setup_already_completed', 'Setup has already been completed');
      // Better Auth user + credential account (ADR-025); the address is the one the operator just typed.
      await tx.insert(users).values({ id: userId, email: input.adminEmail.toLowerCase(), name: input.adminName, role: 'TECH', emailVerified: true });
      await setPasswordCredential(tx, userId, passwordHash);
      // Nobody could check the first admin: recorded as installed configuration, like the grandfather migration (PM/research/11 §4).
      await recordInstalledApproval(tx, { kind: 'user', id: userId, title: `First Tech admin ${input.adminName}` }, 'First Tech admin created by setup, before anyone could check it');
      await tx
        .update(deploymentSettings)
        .set({ orgName: input.orgName, timezone: input.timezone, setupCompletedAt: new Date(), updatedBy: userId })
        .where(eq(deploymentSettings.id, 1));
      await recordAudit(tx, { principal: null, system: { kind: 'SYSTEM', id: 'setup' }, correlationId }, {
        action: 'deployment.setup',
        targetType: 'deployment',
        summary: `First-run setup completed for ${input.orgName}; first Tech admin ${input.adminEmail}`,
      });
    });
    // Default alert rules ship with every deployment (docs/archive/specs/11 §6); admins disable rather than delete them.
    await seedDefaultAlertRules(this.db, correlationId);
    return { userId };
  }
}

/** Cryptographically random one-time setup token (used when OCSO_SETUP_TOKEN is not set). */
export function generatedSetupToken(): string {
  return randomBytes(24).toString('base64url');
}
