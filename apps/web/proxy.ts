import { NextResponse, type NextRequest } from 'next/server';
import { clientIpFromForwardedFor } from './lib/client-ip-core';
import { sessionCookieValue } from './lib/session-cookie';
import { isWebChatPage, webChatPageResponse } from './lib/webchat/frame-policy';

/** Better Auth on the API (ADR-025), served on OCSO's public origin so its cookies, redirects and WebAuthn live here. */
const AUTH_PATH = '/api/auth';
const CLIENT_IP_HEADER = 'x-ocso-client-ip';

/**
 * Optimistic session gate (ADR-020): redirects to /login when the session
 * cookie is missing. It never validates the session — the API authorizes every
 * call and the app layout re-checks it with GET /v1/auth/me.
 */
export function proxy(request: NextRequest): NextResponse | Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (pathname === AUTH_PATH || pathname.startsWith(`${AUTH_PATH}/`)) return authPassThrough(request);
  // Customer web chat widget: public, framed by customer sites (lib/webchat/frame-policy.ts).
  if (isWebChatPage(pathname)) return webChatPageResponse(request);
  if (sessionCookieValue((name) => request.cookies.get(name)?.value)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { category: 'authentication', code: 'unauthenticated', message: 'Sign in required' } },
      { status: 401 },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

/**
 * /api/auth/* → the API's Better Auth handler (browser flows: passkeys, SSO
 * redirects and callbacks). The client IP header is always set here from the
 * trusted proxy hop, never passed through from the browser.
 */
function authPassThrough(request: NextRequest): NextResponse {
  const api = (process.env['API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');
  const target = new URL(`${api}${request.nextUrl.pathname}${request.nextUrl.search}`);
  const forwarded = new Headers(request.headers);
  forwarded.delete(CLIENT_IP_HEADER);
  const ip = clientIpFromForwardedFor(request.headers.get('x-forwarded-for'), process.env['OCSO_TRUSTED_PROXY_HOPS']);
  if (ip) forwarded.set(CLIENT_IP_HEADER, ip);
  return NextResponse.rewrite(target, { request: { headers: forwarded } });
}

export const config = {
  matcher: [
    // Everything except: sign-in and account-recovery pages, the customer web
    // chat, the dev design preview, API-served public ingress (see
    // next.config.ts rewrites), the web chat embed loader, Next internals and
    // static assets. /api/auth IS matched (passed through to the API above).
    '/((?!(?:login|setup|forgot-password|reset-password|invite|recover|webchat|_design|channels|public|oauth|\\.well-known|blobs|ocso-webchat\\.js)(?:/|$)|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest|woff2?)$).*)',
  ],
};
