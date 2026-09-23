import { eq } from 'drizzle-orm';
import { Permission, ROLES, assertCan, mfaRequiredFor, type Role } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import { authPolicy, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { approvalRequiredError } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import { SETTINGS_OBJECT_ID } from '../settings/settings.js';
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

/** Bumped whenever this process applies a policy change, so its cache (below) never serves the old policy. */
let appliedHere = 0;

/** Apply "require MFA for roles" (activation of an approved settings proposal). */
export async function applyAuthPolicy(tx: DbOrTx, actor: ActorContext, input: AuthPolicyInput): Promise<void> {
  const roles = [...new Set(input.requireMfaRoles)];
  const [row] = await tx.select().from(authPolicy).where(eq(authPolicy.id, 1)).limit(1);
  const by = actor.principal?.userId ?? null;
  await tx
    .insert(authPolicy)
    .values({ id: 1, requireMfaRoles: roles, updatedAt: new Date(), updatedBy: by })
    .onConflictDoUpdate({ target: authPolicy.id, set: { requireMfaRoles: roles, updatedAt: new Date(), updatedBy: by } });
  await recordAudit(tx, actor, {
    action: 'auth.policy_update',
    targetType: 'deployment',
    summary: roles.length ? `Require MFA for ${roles.join(', ')}` : 'MFA no longer required for any role',
    before: { requireMfaRoles: row?.requireMfaRoles ?? [] },
    after: { requireMfaRoles: roles },
  });
  appliedHere++;
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
  private cached: { value: AuthPolicyView; at: number; version: number } | null = null;

  constructor(private readonly db: Db) {}

  async get(db: DbOrTx = this.db): Promise<AuthPolicyView> {
    if (this.cached && this.cached.version === appliedHere && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const [row] = await db.select().from(authPolicy).where(eq(authPolicy.id, 1)).limit(1);
    const value: AuthPolicyView = {
      requireMfaRoles: (row?.requireMfaRoles ?? []).filter((r): r is Role => (ROLES as readonly string[]).includes(r)),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
    this.cached = { value, at: Date.now(), version: appliedHere };
    return value;
  }

  /**
   * The policy is part of the deployment settings: a change is a proposal on the settings singleton
   * (PM/research/11 §4, settings-approval.ts) — 409 approval_required here; approval applies it with
   * applyAuthPolicy. Every instance sees an applied change within the 15 s cache.
   */
  async update(actor: ActorContext, _input: AuthPolicyInput): Promise<never> {
    const principal = actor.principal;
    if (!principal) throw forbidden(Permission.DEPLOYMENT_SETTINGS_MANAGE);
    assertCan(principal, Permission.DEPLOYMENT_SETTINGS_MANAGE);
    throw approvalRequiredError('deployment_settings', SETTINGS_OBJECT_ID, 'UPDATE');
  }

  /**
   * MFA follows rights, not only presets: pass the user's effective permissions
   * so a grant of a permission only an MFA-required preset holds also requires
   * a second factor (mfaRequiredFor).
   */
  async mfaState(role: Role, authMethod: string, twoFactorEnabled: boolean, permissions?: ReadonlySet<Permission>): Promise<MfaState> {
    const policy = await this.get();
    return { required: mfaRequiredFor(role, permissions, policy.requireMfaRoles), satisfied: MFA_METHODS.has(authMethod), enrolled: twoFactorEnabled };
  }
}

/** What a long-lived stream was opened with: it closes when the user's rights no longer cover it. */
export interface HeldRights {
  permissions?: ReadonlySet<Permission> | undefined;
  teamIds: readonly string[];
}

/**
 * Long-lived streams (staff SSE, Ask OCSO) re-check their session with this
 * every minute and close when it was revoked or expired (absolute or idle),
 * the user was disabled, the MFA policy no longer admits it, or — given what
 * the stream was opened with — the user lost a permission or a team since
 * (a revoke, an expired grant, a team removal: reductions reach open streams).
 */
export class SessionLiveness {
  constructor(
    private readonly db: Db,
    private readonly policy: Pick<SessionPolicy, 'idleMinutes'>,
    private readonly authPolicy: AuthPolicyService,
  ) {}

  async isLive(sessionId: string, now = new Date(), held?: HeldRights): Promise<boolean> {
    const session = await findLiveSession(this.db, { sessionId }, now);
    if (!session || isIdleExpired(session, this.policy, now)) return false;
    if (held && !stillHolds(held, session)) return false;
    return !mfaPending(await this.authPolicy.mfaState(session.role, session.authMethod, session.twoFactorEnabled, session.permissions));
  }
}

function stillHolds(held: HeldRights, now: { permissions: ReadonlySet<Permission>; teamIds: readonly string[] }): boolean {
  for (const p of held.permissions ?? []) if (!now.permissions.has(p)) return false;
  return held.teamIds.every((t) => now.teamIds.includes(t));
}
