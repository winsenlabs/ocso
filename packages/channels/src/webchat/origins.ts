import { z } from 'zod';

/**
 * Host-site origins allowed to embed the web chat widget (docs/15 §1 origin
 * allowlist). Entries are bare origins — `https://shop.example.com`,
 * `http://localhost:8080` — or a single-label wildcard for subdomains,
 * `https://*.example.com`. The same list drives the widget page's CSP
 * `frame-ancestors`, the widget's postMessage origin checks and the public
 * API's `Origin` check.
 */

const ORIGIN_PATTERN = /^(https?):\/\/(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export const WebChatOrigin = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(ORIGIN_PATTERN, 'must be an origin like https://shop.example.com (no path), optionally https://*.example.com');

/** True when `origin` (as sent by a browser) matches an allowlist entry. */
export function originAllowed(origin: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === 'null' || parsed.origin !== origin.toLowerCase()) return false;
  return allowlist.some((entry) => matches(parsed, entry));
}

function matches(candidate: URL, entry: string): boolean {
  const wildcard = entry.includes('://*.');
  if (!wildcard) return candidate.origin === entry;
  const [scheme, rest = ''] = entry.split('://*.');
  const [suffixHost = '', port = ''] = rest.split(':');
  if (`${candidate.protocol}` !== `${scheme}:`) return false;
  if (candidate.port !== port) return false;
  // `*.example.com` covers `a.example.com` and `a.b.example.com`, never `example.com` itself.
  return candidate.hostname.endsWith(`.${suffixHost}`);
}
