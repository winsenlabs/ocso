import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { CustomerClaims } from './request-context.js';

/**
 * Verifies OCSO customer claims (ES256 JWT, docs/08 §4) against OCSO's public
 * JWKS (`<OCSO public URL>/.well-known/jwks.json`). Keys are cached; an
 * unknown `kid` (OCSO rotated its key) triggers at most one refetch per 30 s.
 */
export interface JwksClaimsOptions {
  jwksUrl: string;
  /** Expected `iss` (OCSO public URL); checked when set. */
  issuer?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

const MIN_REFETCH_MS = 30_000;
const CACHE_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 30;

export class JwksClaimsVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: JwksClaimsOptions) {}

  async verify(token: string): Promise<CustomerClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed');
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: unknown; kid?: unknown };
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new Error('unsupported header');
    const key = await this.key(header.kid);
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    if (!ok) throw new Error('bad signature');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('missing sub');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < now) throw new Error('expired');
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > now) throw new Error('not yet valid');
    if (this.options.issuer && payload.iss !== this.options.issuer) throw new Error('wrong issuer');
    return { sub: payload.sub, exp: payload.exp };
  }

  private async key(kid: string): Promise<KeyObject> {
    const stale = Date.now() - this.fetchedAt > CACHE_MS;
    if (stale || (!this.keys.has(kid) && Date.now() - this.fetchedAt > MIN_REFETCH_MS)) await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw new Error('unknown key');
    return key;
  }

  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const res = await (this.options.fetch ?? fetch)(this.options.jwksUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`jwks ${res.status}`);
        const body = (await res.json()) as { keys?: Array<Record<string, string>> };
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid || !jwk.x || !jwk.y) continue;
          next.set(jwk.kid, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }));
        }
        this.keys = next;
      } finally {
        this.fetchedAt = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
