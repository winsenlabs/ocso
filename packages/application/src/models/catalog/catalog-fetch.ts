import { DomainError, ErrorCategory } from '@ocso/domain';
import { createGuardedFetch, type FetchFn, type GuardedFetch } from '@ocso/mcp';

/**
 * Outbound fetch for the model catalogs (ADR-027): the SSRF guard (public
 * https only, every DNS answer validated, size cap, deadlines) plus a host
 * allowlist checked on the first URL and on every redirect hop.
 */

export const CATALOG_HOSTS: readonly string[] = ['models.dev', 'raw.githubusercontent.com'];
/** models.dev api.json is ~5 MB, LiteLLM ~3 MB (September 2026). */
export const CATALOG_MAX_BYTES = 32 * 1024 * 1024;
export const CATALOG_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

export class CatalogHostNotAllowedError extends DomainError {
  constructor(host: string) {
    super(ErrorCategory.POLICY_DENIED, 'catalog_host_not_allowed', 'Model catalog URL host is not allowlisted', { host });
  }
}

function assertAllowed(url: URL, hosts: readonly string[]): void {
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname.toLowerCase())) throw new CatalogHostNotAllowedError(url.hostname);
}

/** Wrap any fetch with the host allowlist and manual, re-checked redirects. */
export function allowlistedFetch(base: FetchFn, hosts: readonly string[] = CATALOG_HOSTS): FetchFn {
  return async (input, init) => {
    let url = new URL(String(input));
    for (let hop = 0; ; hop++) {
      assertAllowed(url, hosts);
      const response = await base(url, { ...init, redirect: 'manual' });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new CatalogHostNotAllowedError(url.hostname);
      url = new URL(location, url);
    }
  };
}

/** Production catalog fetch: SSRF guard + allowlist. Call `close()` on shutdown. */
export function createCatalogFetch(): GuardedFetch {
  const guarded = createGuardedFetch({
    policy: { allowedInternalHosts: [], allowInsecureHttpHosts: [] },
    network: 'PUBLIC',
    limits: { maxResponseBytes: CATALOG_MAX_BYTES, defaultRequestTimeoutMs: CATALOG_TIMEOUT_MS, maxRedirects: 0 },
  });
  return { fetch: allowlistedFetch(guarded.fetch), close: () => guarded.close() };
}
