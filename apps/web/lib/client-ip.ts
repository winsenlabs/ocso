import 'server-only';
import { isIP } from 'node:net';
import { headers } from 'next/headers';

/**
 * The browser's IP as seen by the trusted reverse proxy in front of the web
 * app (ALB, Caddy, nginx). Proxies append to X-Forwarded-For, so the entry
 * OCSO_TRUSTED_PROXY_HOPS from the right is the one no client can forge.
 * With 0 hops (web exposed directly) the header is client-controlled and ignored.
 */
export async function clientIp(): Promise<string | undefined> {
  const hops = Number(process.env['OCSO_TRUSTED_PROXY_HOPS'] ?? 1);
  if (!Number.isInteger(hops) || hops < 1) return undefined;
  const chain = ((await headers()).get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = chain[chain.length - hops];
  return candidate && isIP(candidate) ? candidate : undefined;
}
