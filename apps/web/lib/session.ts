import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { ROLE_LABELS, isPermission, type Permission, type Role } from '@ocso/auth';
import { fetchMe, type SessionUser } from './api/auth';
import { readSessionToken } from './api/client';
import { ApiError } from './api/errors';

export interface Session {
  user: SessionUser;
  role: Role;
  roleLabel: string;
  permissions: ReadonlySet<Permission>;
}

/**
 * The current user, validated against the API (GET /v1/auth/me) once per
 * request. Returns null when there is no cookie or the API rejects the token;
 * any other failure (API down) propagates to the error boundary.
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
    };
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthenticated) return null;
    throw err;
  }
});

/** For app routes: the session, or a redirect to /login. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export function hasPermission(session: Session, permission: Permission): boolean {
  return session.permissions.has(permission);
}

export function hasAnyPermission(session: Session, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => session.permissions.has(p));
}
