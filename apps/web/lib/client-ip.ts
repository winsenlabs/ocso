import 'server-only';
import { headers } from 'next/headers';
import { clientIpFromForwardedFor } from './client-ip-core';

/**
 * The browser's IP as seen by the trusted reverse proxy in front of the web
 * app (see client-ip-core.ts; OCSO_TRUSTED_PROXY_HOPS). Sent to the API as
 * x-ocso-client-ip for throttling, rate limits and the audit trail.
 */
export async function clientIp(): Promise<string | undefined> {
  return clientIpFromForwardedFor((await headers()).get('x-forwarded-for'), process.env['OCSO_TRUSTED_PROXY_HOPS']);
}
