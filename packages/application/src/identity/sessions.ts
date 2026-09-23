import { and, eq, gt } from 'drizzle-orm';
import { computeEffectivePermissions, isPermission, type Permission, type PermissionOverride, type Principal } from '@ocso/auth';
import { authSessions, users, type DbOrTx } from '@ocso/db';
import { ACTIVE_OVERRIDES_JSON, TEAM_IDS_ARRAY } from './permissions/state.js';

/**
 * Session policy (ADR-025). Better Auth owns the session rows; OCSO adds the
 * idle window and per-account sign-in throttling on top.
 */
export interface SessionPolicy {
  /** Sessions end after this long without an authenticated request. */
  idleMinutes: number;
  /** Hard lifetime from sign-in (Better Auth `session.expiresIn`, refresh disabled). */
  absoluteHours: number;
  /** Failed sign-ins allowed per email within the window before throttling. */
  maxFailures: number;
  failureWindowMinutes: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleMinutes: 120,
  absoluteHours: 24,
  maxFailures: 8,
  failureWindowMinutes: 15,
};

/** How a session was established (auth_sessions.auth_method). */
export type AuthMethod = 'password' | 'mfa' | 'passkey' | 'sso';

/** Methods that count as multi-factor for the "require MFA for roles" policy. */
export const MFA_METHODS: ReadonlySet<string> = new Set<AuthMethod>(['mfa', 'passkey', 'sso']);

/** Idle expiry is refreshed at most this often, so reads stay cheap. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

/**
 * Build the authorization principal: preset ∪ active grants − active revokes
 * (PM/research/11 §3.3) and team memberships, in one round trip. Grant changes
 * take effect on the next request; nothing is cached.
 */
export async function loadPrincipal(db: DbOrTx, userId: string, via: Principal['via'], sessionId?: string): Promise<Principal | null> {
  const [user] = await db
    .select({ id: users.id, role: users.role, name: users.name, status: users.status, teamIds: TEAM_IDS_ARRAY, overrides: ACTIVE_OVERRIDES_JSON })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.status !== 'ACTIVE') return null;
  const overrides = toOverrides(user.overrides);
  return {
    userId: user.id,
    role: user.role,
    displayName: user.name,
    teamIds: user.teamIds,
    via,
    sessionId,
    permissions: computeEffectivePermissions(user.role, overrides),
  };
}

/** Active overrides as ACTIVE_OVERRIDES_JSON returns them. Expiry is already applied in SQL (the database clock); unknown permission names grant nothing. */
function toOverrides(rows: ReadonlyArray<{ p: string; e: 'GRANT' | 'REVOKE' }>): PermissionOverride[] {
  return rows.flatMap((o) => (isPermission(o.p) ? [{ permission: o.p, effect: o.e, expiresAt: null }] : []));
}

export interface LiveSession {
  sessionId: string;
  userId: string;
  role: Principal['role'];
  /** Effective permissions now (preset ∪ active grants − active revokes). */
  permissions: ReadonlySet<Permission>;
  teamIds: string[];
  authMethod: string;
  twoFactorEnabled: boolean;
  lastActiveAt: Date;
  expiresAt: Date;
}

/**
 * The session row (not expired) with the facts OCSO's policy needs. Returns
 * null for a missing/expired session or a disabled user.
 */
export async function findLiveSession(db: DbOrTx, where: { token: string } | { sessionId: string }, now = new Date()): Promise<LiveSession | null> {
  const [row] = await db
    .select({
      sessionId: authSessions.id,
      userId: authSessions.userId,
      authMethod: authSessions.authMethod,
      lastActiveAt: authSessions.lastActiveAt,
      expiresAt: authSessions.expiresAt,
      role: users.role,
      status: users.status,
      twoFactorEnabled: users.twoFactorEnabled,
      teamIds: TEAM_IDS_ARRAY,
      overrides: ACTIVE_OVERRIDES_JSON,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and('token' in where ? eq(authSessions.token, where.token) : eq(authSessions.id, where.sessionId), gt(authSessions.expiresAt, now)))
    .limit(1);
  if (!row || row.status !== 'ACTIVE') return null;
  const { status: _status, overrides, ...live } = row;
  return { ...live, permissions: computeEffectivePermissions(live.role, toOverrides(overrides)) };
}

export function isIdleExpired(session: Pick<LiveSession, 'lastActiveAt'>, policy: Pick<SessionPolicy, 'idleMinutes'>, now = new Date()): boolean {
  return now.getTime() - session.lastActiveAt.getTime() > policy.idleMinutes * 60_000;
}

/** Record activity (at most once a minute) so the idle window slides. */
export async function touchSession(db: DbOrTx, session: Pick<LiveSession, 'sessionId' | 'lastActiveAt'>, now = new Date()): Promise<void> {
  if (now.getTime() - session.lastActiveAt.getTime() < ACTIVITY_WRITE_INTERVAL_MS) return;
  await db.update(authSessions).set({ lastActiveAt: now }).where(eq(authSessions.id, session.sessionId));
}

export async function deleteSession(db: DbOrTx, sessionId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.id, sessionId));
}
