import 'server-only';
import { cookies, headers } from 'next/headers';
import { apiBaseUrl, readSessionToken } from '../api/client';
import { clientIp } from '../client-ip';
import { isAuthCookie } from '../session-cookie';
import { isDeletion, parseSetCookie } from './set-cookie';

/**
 * Server-side calls to Better Auth (ADR-025) for server actions and server
 * components: the same /api/auth endpoints the browser could call, reached
 * over the internal network with the proxy-verified client IP (rate limits)
 * and the session as Bearer. Set-Cookie answers (new session, 2FA challenge,
 * sign-out) are relayed to the browser, so Better Auth stays the only issuer
 * of its cookies.
 */
export interface AuthResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Better Auth error code, e.g. INVALID_EMAIL_OR_PASSWORD. */
  code: string | null;
  message: string | null;
}

export interface AuthCallOptions {
  method?: 'GET' | 'POST';
  /** Send the signed-in session as `Authorization: Bearer`. */
  session?: boolean;
  /** Better Auth cookies to forward from the browser (e.g. the two-factor challenge). */
  forwardCookies?: readonly string[];
  /** Apply Set-Cookie to the browser (server actions / route handlers only; default true). */
  relay?: boolean;
}

const TIMEOUT_MS = 10_000;

export async function callAuth<T>(path: string, body: unknown, options: AuthCallOptions = {}): Promise<AuthResult<T>> {
  const method = options.method ?? 'POST';
  const request = await headers();
  const out = new Headers({ accept: 'application/json' });
  if (method === 'POST') out.set('content-type', 'application/json');
  const ip = await clientIp();
  if (ip) out.set('x-ocso-client-ip', ip);
  const userAgent = request.get('user-agent');
  if (userAgent) out.set('user-agent', userAgent.slice(0, 300));
  if (options.session) {
    const token = await readSessionToken();
    if (token) out.set('authorization', `Bearer ${token}`);
  }
  if (options.forwardCookies?.length) {
    const jar = await cookies();
    const pairs = options.forwardCookies
      .flatMap((name) => [`__Secure-${name}`, name])
      .map((name) => jar.get(name))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => `${c.name}=${encodeURIComponent(c.value)}`);
    if (pairs.length) {
      out.set('cookie', pairs.join('; '));
      // Cookie-bearing requests must carry the page's origin (Better Auth's CSRF check).
      const origin = request.get('origin') ?? process.env['OCSO_PUBLIC_URL'];
      if (origin) out.set('origin', new URL(origin).origin);
    }
  }

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/api/auth${path}`, {
      method,
      headers: out,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    return { ok: false, status: 503, data: null, code: 'UNREACHABLE', message: 'The OCSO API is not reachable.' };
  }
  if (options.relay !== false) await relayAuthCookies(res);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: json as T, code: null, message: null };
  const error = (json ?? {}) as { code?: unknown; message?: unknown };
  return {
    ok: false,
    status: res.status,
    data: null,
    code: typeof error.code === 'string' ? error.code : res.status === 429 ? 'TOO_MANY_REQUESTS' : null,
    message: typeof error.message === 'string' ? error.message : null,
  };
}

/** Apply Better Auth's Set-Cookie headers to the browser's cookie store. */
export async function relayAuthCookies(res: Response): Promise<void> {
  const setCookies = res.headers.getSetCookie();
  if (!setCookies.length) return;
  const jar = await cookies();
  for (const header of setCookies) {
    const cookie = parseSetCookie(header);
    if (!cookie || !isAuthCookie(cookie.name)) continue;
    if (isDeletion(cookie)) {
      jar.delete({ name: cookie.name, path: cookie.path });
      continue;
    }
    jar.set(cookie.name, cookie.value, {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      path: cookie.path,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.maxAge !== undefined ? { maxAge: cookie.maxAge } : {}),
      ...(cookie.expires ? { expires: cookie.expires } : {}),
    });
  }
}

/** Remove every Better Auth cookie from the browser (after sign-out, or a dead session). */
export async function clearAuthCookies(): Promise<void> {
  const jar = await cookies();
  for (const cookie of jar.getAll()) if (isAuthCookie(cookie.name)) jar.delete({ name: cookie.name, path: '/' });
}

export { authMessage } from './messages';
