import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { DomainError } from '@ocso/domain';
import { loginAttempts, sessions, teamMembers, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { nowOf, type ActorContext } from '../shared/context.js';
import { verifyPassword } from './password.js';

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
  /** Failed attempts allowed per email within the window before throttling. */
  maxFailures: number;
  failureWindowMinutes: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMinutes: 120,
  absoluteHours: 24,
  maxFailures: 8,
  failureWindowMinutes: 15,
};

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
  principal: Principal;
}

/** An address may fail this many times the per-account limit (shared NAT/offices) before it is paused. */
const IP_FAILURE_MULTIPLIER = 5;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const authError = (code: string, message: string) => new DomainError('authentication', code, message);

/** Server-side sessions (ADR-010): random token, only its hash is stored. */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
    private readonly now?: () => Date,
  ) {}

  /** `ipVerified`: the address is the end user's (forwarded by the web tier), not an intermediate hop. */
  async login(email: string, password: string, meta: { ip?: string | undefined; ipVerified?: boolean | undefined; userAgent?: string | undefined; correlationId: string }): Promise<IssuedSession> {
    const now = nowOf({ now: this.now });
    await this.assertNotThrottled(email, meta.ipVerified ? meta.ip : undefined, now);
    const [user] = await this.db.select().from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await verifyPassword(password, user?.passwordHash ?? 'scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    const success = Boolean(user && ok && user.status === 'ACTIVE');
    await this.db.insert(loginAttempts).values({ id: uuidv7(), email, ip: meta.ip ?? null, success, occurredAt: now });
    if (!success || !user) {
      throw authError('invalid_credentials', 'Invalid email or password');
    }
    const token = randomBytes(32).toString('base64url');
    const sessionId = uuidv7();
    const expiresAt = new Date(now.getTime() + this.policy.absoluteHours * 3_600_000);
    await this.db.transaction(async (tx) => {
      await tx.insert(sessions).values({
        id: sessionId,
        tokenHash: hashToken(token),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + this.policy.idleMinutes * 60_000),
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      });
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      const principal = await loadPrincipal(tx, user.id, 'UI', sessionId);
      await recordAudit(tx, { principal, correlationId: meta.correlationId, ip: meta.ip }, {
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        summary: `${user.email} signed in`,
      });
    });
    const principal = await loadPrincipal(this.db, user.id, 'UI', sessionId);
    if (!principal) throw authError('invalid_credentials', 'Invalid email or password');
    return { token, sessionId, expiresAt, principal };
  }

  /** Validate a bearer token and slide the idle window. Returns null when invalid. */
  async authenticate(token: string): Promise<Principal | null> {
    const now = nowOf({ now: this.now });
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now), gt(sessions.idleExpiresAt, now)))
      .limit(1);
    if (!session) return null;
    const principal = await loadPrincipal(this.db, session.userId, 'UI', session.id);
    if (!principal) return null;
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + this.policy.idleMinutes * 60_000) })
        .where(eq(sessions.id, session.id));
    }
    return principal;
  }

  async logout(token: string, actor: ActorContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(sessions)
        .set({ revokedAt: nowOf({ now: this.now }) })
        .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
        .returning({ userId: sessions.userId });
      if (revoked) {
        await recordAudit(tx, actor, { action: 'auth.logout', targetType: 'user', targetId: revoked.userId, summary: 'signed out' });
      }
    });
  }

  /** Revoke every session of a user (deactivation, role change). */
  async revokeAllForUser(tx: DbOrTx, userId: string): Promise<void> {
    await tx.update(sessions).set({ revokedAt: nowOf({ now: this.now }) }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  private async assertNotThrottled(email: string, ip: string | undefined, now: Date): Promise<void> {
    const since = new Date(now.getTime() - this.policy.failureWindowMinutes * 60_000);
    // Credential stuffing spreads failures across many accounts from one address.
    if (ip) {
      const [fromIp] = await this.db
        .select({ failures: sql<number>`count(*)::int` })
        .from(loginAttempts)
        .where(and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gt(loginAttempts.occurredAt, since)));
      if ((fromIp?.failures ?? 0) >= this.policy.maxFailures * IP_FAILURE_MULTIPLIER) {
        throw authError('too_many_attempts', 'Too many failed sign-in attempts. Try again later.');
      }
    }
    const [row] = await this.db
      .select({ failures: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(and(sql`lower(${loginAttempts.email}) = lower(${email})`, eq(loginAttempts.success, false), gt(loginAttempts.occurredAt, since)));
    if ((row?.failures ?? 0) >= this.policy.maxFailures) {
      throw authError('too_many_attempts', 'Too many failed sign-in attempts. Try again later.');
    }
  }
}

/** Build the authorization principal for a user (role + team memberships). */
export async function loadPrincipal(db: DbOrTx, userId: string, via: Principal['via'], sessionId?: string): Promise<Principal | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.status !== 'ACTIVE') return null;
  const teamRows = await db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId));
  return {
    userId: user.id,
    role: user.role,
    displayName: user.name,
    teamIds: teamRows.map((t) => t.teamId),
    via,
    sessionId,
  };
}
