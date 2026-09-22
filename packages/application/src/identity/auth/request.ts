import { isIP } from 'node:net';

/** Header the web tier sets to the proxy-verified browser address (never trusted from browsers directly). */
export const CLIENT_IP_HEADER = 'x-ocso-client-ip';

interface HeaderSource {
  request?: Request | undefined;
  headers?: Headers | undefined;
}

export const headersOf = (ctx: HeaderSource): Headers | undefined => ctx.request?.headers ?? ctx.headers;

/** The client address forwarded by the web tier, when it is a valid IP. */
export function clientIpOf(ctx: HeaderSource): string | undefined {
  const value = headersOf(ctx)?.get(CLIENT_IP_HEADER)?.trim();
  return value && isIP(value) ? value : undefined;
}

export function correlationIdOf(ctx: HeaderSource, fallback = 'auth'): string {
  const value = headersOf(ctx)?.get('x-correlation-id');
  return value && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : fallback;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The raw session token from `Authorization: Bearer <token.signature>` or the
 * session cookie. Unverified: used only to deny (idle, pending MFA) or to
 * record activity; Better Auth verifies the signature before trusting it.
 */
export function sessionTokenOf(ctx: HeaderSource, cookieName: string): string | null {
  const headers = headersOf(ctx);
  if (!headers) return null;
  const authorization = headers.get('authorization');
  if (authorization && authorization.slice(0, 7).toLowerCase() === 'bearer ') {
    return decode(authorization.slice(7).trim()).split('.')[0] || null;
  }
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === cookieName) return decode(part.slice(eq + 1).trim()).split('.')[0] || null;
  }
  return null;
}

/** Whether `email`'s domain is one of the comma-separated `domains` (or a subdomain of one). */
export function emailDomainMatches(email: string, domains: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return domains
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .some((d) => domain === d || domain.endsWith(`.${d}`));
}
