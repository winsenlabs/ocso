import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { EgressBlockedError } from '../errors.js';
import type { DnsResolver, EgressLimits, EgressPolicy, McpNetwork } from '../types.js';
import { addressAllowed, hostVerdict, normalizeHost, type HostVerdict } from './address-policy.js';
import { nodeExchange } from './node-http.js';

/**
 * SSRF-guarded `fetch` (research/03 §5). Every MCP, metadata, registration
 * and token request made on behalf of an admin-entered URL goes through one.
 *
 * - `https:` only, unless the host is in `allowInsecureHttpHosts`.
 * - IP literals are checked up front (the DNS hook is not called for them).
 * - Hostnames are resolved by a custom `lookup` that validates EVERY answer
 *   and hands the socket exactly the validated addresses (no rebinding gap).
 * - Redirects: GET/HEAD only, capped, each hop re-validated; credentials and
 *   custom headers are dropped on cross-origin hops.
 * - Connect/idle deadlines, whole-request deadline when no signal is given,
 *   and a response-size cap.
 *
 * Agents are per instance (per policy + network) so keep-alive sockets opened
 * for an allowlisted internal host can never be reused by a stricter policy.
 */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GuardedFetch {
  readonly fetch: FetchFn;
  /** Destroy pooled keep-alive sockets. */
  close(): void;
}

export interface GuardedFetchOptions {
  policy: EgressPolicy;
  network: McpNetwork;
  limits?: Partial<EgressLimits> | undefined;
  resolver?: DnsResolver | undefined;
}

export const DEFAULT_EGRESS_LIMITS: Readonly<EgressLimits> = Object.freeze({
  maxRedirects: 3,
  maxResponseBytes: 8 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  defaultRequestTimeoutMs: 30_000,
});

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** Headers kept when a redirect crosses origins (everything else, incl. credentials, is dropped). */
const CROSS_ORIGIN_SAFE_HEADERS = ['accept', 'accept-language', 'user-agent', 'mcp-protocol-version'];

export const systemResolver: DnsResolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, order: 'verbatim' });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Validate scheme, userinfo and literal-IP destination; returns the host verdict for DNS checks. */
export function assertUrlAllowed(url: URL, policy: EgressPolicy, network: McpNetwork): HostVerdict {
  const host = normalizeHost(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EgressBlockedError('insecure_scheme', host || null);
  if (!host) throw new EgressBlockedError('invalid_url', null);
  if (url.username || url.password) throw new EgressBlockedError('credentials_in_url', host);
  const verdict = hostVerdict(host, network, policy);
  if (url.protocol === 'http:' && !verdict.insecureHttpAllowed) throw new EgressBlockedError('insecure_scheme', host);
  if (net.isIP(host)) {
    const outcome = addressAllowed(host, verdict);
    if (outcome !== 'ok') throw new EgressBlockedError(outcome, host);
  }
  return verdict;
}

function familyOf(options: dns.LookupOptions): 0 | 4 | 6 {
  const f = options.family;
  if (f === 4 || f === 'IPv4') return 4;
  if (f === 6 || f === 'IPv6') return 6;
  return 0;
}

function guardedLookup(resolver: DnsResolver, verdict: HostVerdict): net.LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (answers) => {
        const family = familyOf(options);
        const candidates = answers.filter((a) => family === 0 || a.family === family);
        if (candidates.length === 0) {
          callback(new EgressBlockedError('dns_failure', hostname) as unknown as NodeJS.ErrnoException, '', 4);
          return;
        }
        for (const a of candidates) {
          const outcome = addressAllowed(a.address, verdict);
          if (outcome !== 'ok') {
            callback(new EgressBlockedError(outcome, hostname) as unknown as NodeJS.ErrnoException, '', 4);
            return;
          }
        }
        const first = candidates[0] as { address: string; family: 4 | 6 };
        if (options.all) callback(null, candidates);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 4),
    );
  };
}

async function normalizeRequest(url: URL, init: RequestInit | undefined): Promise<{ method: string; headers: Headers; body: Uint8Array | null }> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (init?.body === undefined || init.body === null) return { method, headers: new Headers(init?.headers), body: null };
  // Let WHATWG Request serialize any BodyInit (string, URLSearchParams, bytes…) and set content-type.
  const req = new Request(url, { method, headers: init.headers ?? {}, body: init.body, duplex: 'half' } as RequestInit);
  return { method, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) };
}

function stripForCrossOrigin(headers: Headers): Headers {
  const kept = new Headers();
  for (const name of CROSS_ORIGIN_SAFE_HEADERS) {
    const v = headers.get(name);
    if (v !== null) kept.set(name, v);
  }
  return kept;
}

export function createGuardedFetch(options: GuardedFetchOptions): GuardedFetch {
  const limits: EgressLimits = { ...DEFAULT_EGRESS_LIMITS, ...options.limits };
  const resolver = options.resolver ?? systemResolver;
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, minVersion: 'TLSv1.2' });

  const guarded: FetchFn = async (input, init) => {
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw new EgressBlockedError('invalid_url', null);
    }
    assertUrlAllowed(url, options.policy, options.network); // before any parsing that could throw differently
    const signal = init?.signal ?? AbortSignal.timeout(limits.defaultRequestTimeoutMs);
    let { method, headers, body } = await normalizeRequest(url, init);
    const followRedirects = (init?.redirect ?? 'follow') === 'follow' && (method === 'GET' || method === 'HEAD');

    for (let hop = 0; ; hop++) {
      const verdict = assertUrlAllowed(url, options.policy, options.network);
      const res = await nodeExchange(url, {
        method,
        headers,
        body,
        signal,
        lookup: guardedLookup(resolver, verdict),
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
        limits,
      });
      const location = res.headers.get('location');
      if (!REDIRECT_STATUS.has(res.status) || !location) return res;
      if (init?.redirect === 'error') {
        await res.body?.cancel();
        throw new EgressBlockedError('redirect_not_allowed', url.hostname);
      }
      if (!followRedirects) return res;
      await res.body?.cancel();
      if (hop >= limits.maxRedirects) throw new EgressBlockedError('too_many_redirects', url.hostname);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new EgressBlockedError('invalid_url', url.hostname);
      }
      if (next.origin !== url.origin) headers = stripForCrossOrigin(headers);
      if (method === 'HEAD') body = null;
      url = next;
    }
  };

  return {
    fetch: guarded,
    close() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
