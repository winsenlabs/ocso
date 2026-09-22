/**
 * Session cookie contract (ADR-020). The API session token lives only in this
 * httpOnly cookie; browsers never read it and never call the API directly.
 * Shared by proxy.ts, server actions and the session loader.
 */
export const SESSION_COOKIE = 'ocso_session';

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * `secure` follows NODE_ENV unless SESSION_COOKIE_SECURE overrides it (for a
 * Compose deployment reached over plain HTTP on a private network).
 */
export function sessionCookieOptions(expiresAt: string, now: Date = new Date()): SessionCookieOptions {
  const override = process.env['SESSION_COOKIE_SECURE'];
  const secure = override === undefined ? process.env.NODE_ENV === 'production' : override === 'true';
  const seconds = Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000);
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 };
}

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.startsWith('/login') || value.startsWith('/setup')) return '/';
  return value;
}
