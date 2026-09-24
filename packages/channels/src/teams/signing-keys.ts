import { importJWK, type JWK } from 'jose';
import { z } from 'zod';
import { DomainError, ErrorCategory } from '@ocso/domain';
import type { ChannelFetch } from '../contract/types.js';
import { BodyTooLargeError, readBodyWithLimit } from '../common/http.js';

/**
 * Bot Framework token-signing keys: the OpenID metadata document names a
 * `jwks_uri`; its keys (RSA, with the channels that endorse each key) sign
 * the tokens the Bot Connector sends to the bot. Keys are cached per
 * metadata URL for a bounded time (Microsoft rolls them every few weeks and
 * publishes the next key ahead of time). An unknown `kid` refreshes the set
 * at most once per REFRESH_COOLDOWN_MS, so forged `kid`s cannot turn every
 * webhook into two provider calls. Fetches go through the adapter's
 * guarded egress fetch; concurrent misses share one fetch.
 */

export const KEYS_TTL_MS = 12 * 3_600_000;
export const REFRESH_COOLDOWN_MS = 5 * 60_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_KEYS = 50;

const Metadata = z.looseObject({ jwks_uri: z.string().min(1).max(2_048) });
const Jwk = z.looseObject({
  kid: z.string().min(1).max(256),
  kty: z.string(),
  n: z.string().optional(),
  e: z.string().optional(),
  endorsements: z.array(z.string()).max(100).optional(),
});
const Jwks = z.looseObject({ keys: z.array(z.unknown()).max(MAX_KEYS) });

export interface SigningKey {
  key: CryptoKey | Uint8Array;
  /** Channels (e.g. `msteams`) that endorse the key; empty = no endorsement list published. */
  endorsements: readonly string[];
}

interface KeySet {
  keys: ReadonlyMap<string, SigningKey>;
  fetchedAt: number;
}

/** The signing keys could not be fetched: the webhook answers 502 so the Bot Connector retries. */
export class SigningKeysUnavailableError extends DomainError {
  constructor(reason: string) {
    super(ErrorCategory.PROVIDER_UNAVAILABLE, 'teams_signing_keys_unavailable', `Bot Framework signing keys unavailable: ${reason}`);
  }
}

function isSecureOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

export class BotFrameworkKeyStore {
  private readonly sets = new Map<string, KeySet>();
  private readonly inflight = new Map<string, Promise<KeySet>>();

  constructor(
    private readonly fetchImpl: ChannelFetch,
    private readonly clock: () => number,
    private readonly timeoutMs = 10_000,
  ) {}

  /** The key with this `kid`, refreshing a stale or incomplete set; null when Microsoft does not publish it. */
  async key(metadataUrl: string, kid: string): Promise<SigningKey | null> {
    const now = this.clock();
    let set = this.sets.get(metadataUrl);
    if (!set || now - set.fetchedAt >= KEYS_TTL_MS) set = await this.refresh(metadataUrl);
    else if (!set.keys.has(kid) && now - set.fetchedAt >= REFRESH_COOLDOWN_MS) set = await this.refresh(metadataUrl);
    return set.keys.get(kid) ?? null;
  }

  /** How many signing keys are published (cached while fresh); throws SigningKeysUnavailableError. */
  async count(metadataUrl: string): Promise<number> {
    const set = this.sets.get(metadataUrl);
    if (set && this.clock() - set.fetchedAt < KEYS_TTL_MS) return set.keys.size;
    return (await this.refresh(metadataUrl)).keys.size;
  }

  /** Drop cached keys (tests, and an operator-forced refresh). */
  clear(): void {
    this.sets.clear();
  }

  private refresh(metadataUrl: string): Promise<KeySet> {
    const pending = this.inflight.get(metadataUrl);
    if (pending) return pending;
    const run = this.load(metadataUrl)
      .then((set) => {
        this.sets.set(metadataUrl, set);
        return set;
      })
      .finally(() => this.inflight.delete(metadataUrl));
    this.inflight.set(metadataUrl, run);
    return run;
  }

  private async load(metadataUrl: string): Promise<KeySet> {
    const metadata = Metadata.safeParse(await this.getJson(metadataUrl, 'OpenID metadata'));
    if (!metadata.success || !URL.canParse(metadata.data.jwks_uri)) throw new SigningKeysUnavailableError('OpenID metadata has no valid jwks_uri');
    const jwksUrl = new URL(metadata.data.jwks_uri);
    // Microsoft serves both over https; plain http only for a loopback test stub named by a loopback metadata URL.
    if (!isSecureOrLoopback(jwksUrl) || (jwksUrl.protocol === 'http:' && new URL(metadataUrl).protocol !== 'http:')) {
      throw new SigningKeysUnavailableError('jwks_uri must use https');
    }
    const jwks = Jwks.safeParse(await this.getJson(jwksUrl.toString(), 'signing keys'));
    if (!jwks.success) throw new SigningKeysUnavailableError('signing key document is malformed');
    const keys = new Map<string, SigningKey>();
    for (const raw of jwks.data.keys) {
      const jwk = Jwk.safeParse(raw);
      if (!jwk.success || jwk.data.kty !== 'RSA' || !jwk.data.n || !jwk.data.e) continue;
      try {
        const { endorsements, ...material } = jwk.data;
        const key = await importJWK({ kty: 'RSA', n: material.n, e: material.e } as JWK, 'RS256');
        keys.set(jwk.data.kid, { key, endorsements: endorsements ?? [] });
      } catch {
        // An unusable key is skipped; tokens signed with it fail as "unknown key".
      }
    }
    if (!keys.size) throw new SigningKeysUnavailableError('no usable RSA signing keys published');
    return { keys, fetchedAt: this.clock() };
  }

  private async getJson(url: string, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new SigningKeysUnavailableError(`could not fetch the ${what}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SigningKeysUnavailableError(`the ${what} answered HTTP ${response.status}`);
    }
    try {
      const body = await readBodyWithLimit(response, MAX_DOCUMENT_BYTES);
      return JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    } catch (error) {
      throw new SigningKeysUnavailableError(error instanceof BodyTooLargeError ? `the ${what} is too large` : `the ${what} is not valid JSON`);
    }
  }
}
