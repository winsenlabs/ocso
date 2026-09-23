/**
 * Embedding allowlist matching for the browser side (mirror of
 * packages/channels/src/webchat/origins.ts, which the API and channel
 * settings use; that package is server-only). Entries are bare origins or
 * `scheme://*.domain[:port]` wildcards.
 */

export function originAllowed(origin: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === 'null' || parsed.origin !== origin.toLowerCase()) return false;
  return allowlist.some((entry) => matches(parsed, entry.toLowerCase()));
}

function matches(candidate: URL, entry: string): boolean {
  if (!entry.includes('://*.')) return candidate.origin === entry;
  const [scheme, rest = ''] = entry.split('://*.');
  const [suffixHost = '', port = ''] = rest.split(':');
  if (candidate.protocol !== `${scheme}:` || candidate.port !== port) return false;
  return candidate.hostname.endsWith(`.${suffixHost}`);
}

/** The origin part of a URL string, or null. */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
