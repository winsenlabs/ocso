import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { ROLE_LABELS, isPermission, type Permission, type Role } from '@ocso/auth';
import { fetchMe, type MfaState, type SessionUser } from './api/auth';
import { readSessionToken } from './api/client';
import { ApiError } from './api/errors';

export interface Session {
  user: SessionUser;
  role: Role;
  roleLabel: string;
  permissions: ReadonlySet<Permission>;
  mfa: MfaState;
}

/**
 * The current user, validated against the API (GET /v1/auth/me, Better Auth
 * session as Bearer) once per request. Returns null when there is no cookie or
 * the API rejects the session; any other failure (API down) propagates to the
 * error boundary.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  try {
    const user = await fetchMe(token);
    return {
      user,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      permissions: new Set(user.permissions.filter(isPermission)),
      mfa: user.mfa ?? { required: false, satisfied: true, enrolled: false },
    };
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthenticated) return null;
    throw err;
  }
});

/** The role must use a second factor and this session has none yet (ADR-025). */
export function mfaPending(session: Pick<Session, 'mfa'>): boolean {
  return session.mfa.required && !session.mfa.satisfied;
}

/**
 * For app routes: the session, or a redirect to /login. A session whose role
 * requires MFA but that has no second factor goes to /mfa-setup first.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (mfaPending(session)) redirect('/mfa-setup');
  return session;
}

export function hasPermission(session: Session, permission: Permission): boolean {
  return session.permissions.has(permission);
}

export function hasAnyPermission(session: Session, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => session.permissions.has(p));
}
