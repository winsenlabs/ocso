/**
 * OCSO's own public origin, as the API knows it (OCSO_PUBLIC_URL; else the
 * host this request reached, ADR-020 one public origin). Server-side calls to
 * the public web chat API send it as `Origin`: the API only accepts calls
 * without one from native apps or session-pass channels (SPEC §C.3).
 */
export function ocsoOrigin(headers: Pick<Headers, 'get'>): string | null {
  const configured = process.env['OCSO_PUBLIC_URL'];
  if (configured && URL.canParse(configured)) return new URL(configured).origin;
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host) return null;
  const proto = headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
