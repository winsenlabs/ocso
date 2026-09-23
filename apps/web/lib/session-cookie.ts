/**
 * Session cookie contract (ADR-020, ADR-025). Better Auth sets the session
 * cookie (httpOnly, SameSite=Lax, `__Secure-` prefixed when Secure) on the
 * public origin; the BFF reads it server-side and forwards its value to the
 * API as `Authorization: Bearer`. Browsers never read it and never call /v1.
 * Shared by proxy.ts, server actions and the session loader.
 */
export const COOKIE_PREFIX = 'ocso';
export const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;
export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;
/** Pending second-factor challenge after a correct password (10 minutes). */
export const TWO_FACTOR_COOKIE = `${COOKIE_PREFIX}.two_factor`;

/** Every Better Auth cookie name (plain and `__Secure-`), for sign-out and relaying. */
export function isAuthCookie(name: string): boolean {
  return name.replace(/^__Secure-/, '').startsWith(`${COOKIE_PREFIX}.`);
}

/** The session cookie value (secure variant first), from any cookie reader. */
export function sessionCookieValue(get: (name: string) => string | undefined): string | null {
  return get(SECURE_SESSION_COOKIE) ?? get(SESSION_COOKIE) ?? null;
}

/** Pages that must never be a post-login destination (they are part of signing in). */
const AUTH_PAGES = ['/login', '/setup', '/forgot-password', '/reset-password', '/invite', '/recover', '/mfa-setup'];

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (AUTH_PAGES.some((page) => value === page || value.startsWith(`${page}?`) || value.startsWith(`${page}/`))) return '/';
  return value;
}
