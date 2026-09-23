import { NextResponse, type NextRequest } from 'next/server';
import { ocsoOrigin } from './ocso-origin';

/**
 * Response policy for the public widget page `/chat/:publicKey` (runs in
 * proxy.ts, Node runtime). The page is meant to be framed by customer sites,
 * so its CSP `frame-ancestors` comes from the channel's `allowedOrigins`
 * setting (fetched from the public config endpoint, cached briefly):
 * - allowlist set    → only those origins (plus OCSO itself) may frame it;
 * - allowlist empty  → any site may frame it (channel admins should set one);
 * - unknown channel / API unreachable → `'none'` (fail closed; nothing to show).
 * The rest of the CSP pins scripts, connections and forms to OCSO's origin.
 * `script-src` keeps 'unsafe-inline' because App Router pages embed inline
 * bootstrap scripts in their prerendered shell (nonces need fully dynamic
 * rendering); the widget renders customer/agent text only as React text.
 */

const CACHE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 5_000;
const MAX_ENTRIES = 500;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const ORIGIN = /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/;

const cache = new Map<string, { value: string; expires: number }>();

export function isWebChatPage(pathname: string): boolean {
  return pathname === '/chat' || pathname.startsWith('/chat/');
}

function apiBase(): string {
  return (process.env['API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/** `frame-ancestors` sources for an allowlist (validated again: config is untrusted input here). */
export function frameAncestors(allowedOrigins: readonly string[] | null): string {
  if (allowedOrigins === null) return "'none'";
  const origins = allowedOrigins.map((o) => o.toLowerCase()).filter((o) => ORIGIN.test(o));
  if (allowedOrigins.length === 0) return '*';
  return origins.length ? ["'self'", ...origins].join(' ') : "'none'";
}

export function widgetCsp(ancestors: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // Signed media URLs may point at object storage (S3 presigned https URLs).
    "img-src 'self' blob: data: https:",
    "media-src 'self' blob: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

async function allowedOriginsFor(publicKey: string, origin: string | null): Promise<string[] | null> {
  const res = await fetch(`${apiBase()}/public/webchat/${encodeURIComponent(publicKey)}/config`, {
    headers: { accept: 'application/json', ...(origin ? { origin } : {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { allowedOrigins?: unknown };
  return Array.isArray(body.allowedOrigins) ? body.allowedOrigins.filter((o): o is string => typeof o === 'string') : null;
}

export async function framePolicyFor(publicKey: string, now = Date.now(), origin: string | null = null): Promise<string> {
  const hit = cache.get(publicKey);
  if (hit && hit.expires > now) return hit.value;
  let value: string;
  let ttl = CACHE_TTL_MS;
  try {
    value = frameAncestors(await allowedOriginsFor(publicKey, origin));
  } catch {
    value = "'none'";
  }
  if (value === "'none'") ttl = NEGATIVE_TTL_MS;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value ?? '');
  cache.set(publicKey, { value, expires: now + ttl });
  return value;
}

/** proxy.ts entry: the widget page is public (no staff session) and gets the policy above. */
export async function webChatPageResponse(request: NextRequest): Promise<NextResponse> {
  const key = request.nextUrl.pathname.split('/')[2] ?? '';
  const ancestors = KEY.test(key) ? await framePolicyFor(key, Date.now(), ocsoOrigin(request.headers) ?? request.nextUrl.origin) : "'none'";
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', widgetCsp(ancestors));
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  return response;
}
