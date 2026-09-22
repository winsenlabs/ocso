import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/session-cookie';
import { isWebChatPage, webChatPageResponse } from './lib/webchat/frame-policy';

/**
 * Optimistic session gate (ADR-020): redirects to /login when the session
 * cookie is missing. It never validates the token — the API authorizes every
 * call and the app layout re-checks the session with GET /v1/auth/me.
 */
export function proxy(request: NextRequest): NextResponse | Promise<NextResponse> {
  // Customer web chat widget: public, framed by customer sites (lib/webchat/frame-policy.ts).
  if (isWebChatPage(request.nextUrl.pathname)) return webChatPageResponse(request);
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
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

export const config = {
  matcher: [
    // Everything except: auth pages, the customer web chat, the dev design
    // preview, API-served public ingress (see next.config.ts rewrites), the
    // web chat embed loader, Next internals and static assets.
    '/((?!(?:login|setup|webchat|_design|channels|public|oauth|\\.well-known|blobs|ocso-webchat\\.js)(?:/|$)|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)',
  ],
};
