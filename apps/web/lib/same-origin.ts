/**
 * CSRF defence in depth for cookie-authenticated route handlers that change
 * state (server actions get Next's built-in origin check). SameSite=Lax already
 * blocks cross-site POSTs, but "same-site" includes sibling subdomains, so the
 * request must come from this exact origin.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set<string>([new URL(request.url).origin]);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '');
  if (host) allowed.add(`${proto}://${host}`);
  const configured = process.env['OCSO_PUBLIC_URL'];
  if (configured) {
    try {
      allowed.add(new URL(configured).origin);
    } catch {
      // ignore a malformed setting; the request origin still has to match the host
    }
  }
  return allowed.has(origin);
}

export const crossOriginRejected = () =>
  Response.json({ error: { category: 'authorization', code: 'cross_origin_request', message: 'This request must come from the OCSO app itself' } }, { status: 403 });
