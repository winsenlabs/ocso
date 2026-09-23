import { eq } from 'drizzle-orm';
import { Permission, ROLES, assertCan, type Role } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import { authPolicy, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { MFA_METHODS, findLiveSession, isIdleExpired, type SessionPolicy } from './sessions.js';

export const AuthPolicyInput = z.object({
  /** Roles that must sign in with a second factor (TOTP), a passkey or SSO. */
  requireMfaRoles: z.array(z.enum(ROLES)).max(ROLES.length),
});
export type AuthPolicyInput = z.infer<typeof AuthPolicyInput>;

export interface AuthPolicyView {
  requireMfaRoles: Role[];
  updatedAt: string | null;
}

/** Where a user stands against "require MFA for roles". */
export interface MfaState {
  /** The user's role must use a second factor. */
  required: boolean;
  /** This session was established with a second factor (TOTP, passkey or SSO). */
  satisfied: boolean;
  /** The user has an authenticator app enrolled. */
  enrolled: boolean;
}

/** MFA is pending when the role requires it and this session did not use a second factor. */
export const mfaPending = (state: MfaState): boolean => state.required && !state.satisfied;

const CACHE_MS = 15_000;

/**
 * Authentication policy set by the Tech admin (auth_policy singleton). Cached
 * briefly per process; every instance sees a change within 15 s.
 */
export class AuthPolicyService {
  private cached: { value: AuthPolicyView; at: number } | null = null;

  constructor(private readonly db: Db) {}

  async get(db: DbOrTx = this.db): Promise<AuthPolicyView> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const [row] = await db.select().from(authPolicy).where(eq(authPolicy.id, 1)).limit(1);
    const value: AuthPolicyView = {
      requireMfaRoles: (row?.requireMfaRoles ?? []).filter((r): r is Role => (ROLES as readonly string[]).includes(r)),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
    this.cached = { value, at: Date.now() };
    return value;
  }

  async update(actor: ActorContext, input: AuthPolicyInput): Promise<AuthPolicyView> {
    const principal = actor.principal;
    if (!principal) throw forbidden(Permission.DEPLOYMENT_SETTINGS_MANAGE);
    assertCan(principal, Permission.DEPLOYMENT_SETTINGS_MANAGE);
    const roles = [...new Set(input.requireMfaRoles)];
    await this.db.transaction(async (tx) => {
      const before = await this.get(tx);
      await tx
        .insert(authPolicy)
        .values({ id: 1, requireMfaRoles: roles, updatedAt: new Date(), updatedBy: principal.userId })
        .onConflictDoUpdate({ target: authPolicy.id, set: { requireMfaRoles: roles, updatedAt: new Date(), updatedBy: principal.userId } });
      await recordAudit(tx, actor, {
        action: 'auth.policy_update',
        targetType: 'deployment',
        summary: roles.length ? `Require MFA for ${roles.join(', ')}` : 'MFA no longer required for any role',
        before: { requireMfaRoles: before.requireMfaRoles },
        after: { requireMfaRoles: roles },
      });
    });
    this.cached = null;
    return this.get();
  }

  async mfaState(role: Role, authMethod: string, twoFactorEnabled: boolean): Promise<MfaState> {
    const policy = await this.get();
    return { required: policy.requireMfaRoles.includes(role), satisfied: MFA_METHODS.has(authMethod), enrolled: twoFactorEnabled };
  }
}

/**
 * Long-lived streams (staff SSE, Ask OCSO) re-check their session with this
 * every minute and close when it was revoked or expired (absolute or idle),
 * the user was disabled, or the MFA policy no longer admits it.
 */
export class SessionLiveness {
  constructor(
    private readonly db: Db,
    private readonly policy: Pick<SessionPolicy, 'idleMinutes'>,
    private readonly authPolicy: AuthPolicyService,
  ) {}

  async isLive(sessionId: string, now = new Date()): Promise<boolean> {
    const session = await findLiveSession(this.db, { sessionId }, now);
    if (!session || isIdleExpired(session, this.policy, now)) return false;
    return !mfaPending(await this.authPolicy.mfaState(session.role, session.authMethod, session.twoFactorEnabled));
  }
}
