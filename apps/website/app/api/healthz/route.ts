export const dynamic = 'force-dynamic';

/** Container healthcheck: the server is up. It does not call Cloudflare. */
export function GET() {
  return new Response('ok', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}
