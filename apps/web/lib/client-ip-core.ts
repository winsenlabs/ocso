import { isIP } from 'node:net';

/**
 * The browser's IP as seen by the trusted reverse proxy in front of the web
 * app (ALB, Caddy, nginx). Proxies append to X-Forwarded-For, so the entry
 * `hops` from the right is the one no client can forge. With 0 hops (web
 * exposed directly) the header is client-controlled and ignored.
 * Pure: shared by server code (client-ip.ts) and proxy.ts.
 */
export function clientIpFromForwardedFor(forwardedFor: string | null, hopsSetting: string | undefined): string | undefined {
  const hops = Number(hopsSetting ?? 1);
  if (!Number.isInteger(hops) || hops < 1) return undefined;
  const chain = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = chain[chain.length - hops];
  return candidate && isIP(candidate) ? candidate : undefined;
}
