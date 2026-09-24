/**
 * The Bot Connector tells the bot where to reply (`activity.serviceUrl`, e.g.
 * `https://smba.trafficmanager.net/amer/`). OCSO sends its bearer token there,
 * so the URL must be https on a Microsoft Bot Connector host of the channel's
 * cloud (SSRF guard, on top of the guarded egress). A test override may add
 * a local stub host; http is accepted for loopback hosts only.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".trafficmanager.net"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

/** The normalized service URL (no trailing slash), or null when it is not an allowed Bot Connector endpoint. */
export function allowedServiceUrl(value: string | undefined, allowedHosts: readonly string[]): string | null {
  if (!value || value.length > 512 || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return null;
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  const hostname = url.hostname.toLowerCase();
  const ok = allowedHosts.some((raw) => {
    const pattern = raw.toLowerCase();
    // A pattern with a port names exactly that origin; one without matches the default port (any port on loopback).
    if (/:\d+$/.test(pattern)) return url.host.toLowerCase() === pattern;
    return (!url.port || loopback) && hostMatches(hostname, pattern);
  });
  if (!ok) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
