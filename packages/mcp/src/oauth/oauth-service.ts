import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  IssuerMismatchError,
  startAuthorization,
  validateAuthorizationResponseIssuer,
  type AuthorizationServerMetadata,
} from '@modelcontextprotocol/client';
import { probeAuthChallenge, discoverResourceMetadata, resourceMatchesServer } from '../auth/challenge.js';
import { hostMatches } from '../egress/address-policy.js';
import { createGuardedFetch, type GuardedFetch } from '../egress/guarded-fetch.js';
import { McpOAuthError } from '../errors.js';
import type { DnsResolver, EgressLimits, EgressPolicy, McpConnectionTarget, McpNetwork, McpOAuthClientInformation, McpOAuthTokens } from '../types.js';
import { refreshOAuthTokens } from './refresh.js';
import { resolveClientRegistration } from './registration.js';
import { mapOAuthHelperError } from './sdk-errors.js';
import { toSdkClientInformation, tokensFromSdk } from './token-state.js';
import type {
  BeginAuthorizationOptions,
  BeginAuthorizationResult,
  CompleteAuthorizationResult,
  McpPendingAuthorization,
  OAuthCallbackQuery,
} from './types.js';

export interface McpOAuthServiceDeps {
  egress: EgressPolicy;
  limits?: Partial<EgressLimits> | undefined;
  resolver?: DnsResolver | undefined;
  /** Pending-authorization lifetime. Default 10 minutes. */
  pendingTtlMs?: number | undefined;
  now?: (() => number) | undefined;
}

/** Constant-time string equality (hash first so lengths never leak through timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Server-side OAuth 2.1 redirect flow for MCP connections, orchestrated from
 * the SDK's primitives (ADR-021, research/03 §3). OCSO adds what the SDK
 * leaves to callers: PKCE-S256 advertisement refusal, `state` validation,
 * RFC 9207 `iss` enforcement when advertised, issuer-keyed credentials,
 * redirect-scheme validation and SSRF-guarded fetches for every hop.
 */
export class McpOAuthService {
  private readonly now: () => number;

  constructor(private readonly deps: McpOAuthServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async beginAuthorization(
    target: Pick<McpConnectionTarget, 'id' | 'url' | 'network' | 'auth'>,
    options: BeginAuthorizationOptions,
  ): Promise<BeginAuthorizationResult> {
    this.assertRedirectUri(options.redirectUri);
    const gf = this.guardedFetch(target.network);
    try {
      const challenge = await probeAuthChallenge(target.url, gf.fetch);
      const prm = await discoverResourceMetadata(target.url, challenge, gf.fetch);
      if (!prm) throw new McpOAuthError('no_resource_metadata');
      if (!resourceMatchesServer(target.url, prm)) throw new McpOAuthError('resource_mismatch');

      const asUrl = this.pickAuthorizationServer(prm.authorization_servers ?? [], target, options.authorizationServer);
      const metadata = await this.discoverAsMetadata(asUrl, gf);
      this.assertCompatible(metadata);

      const scopes = options.scopes?.length
        ? [...options.scopes]
        : target.auth.strategy === 'OAUTH' && target.auth.scopes.length
          ? [...target.auth.scopes]
          : splitScope(challenge?.scope ?? prm.scopes_supported?.join(' '));
      const scope = scopes.length ? scopes.join(' ') : undefined;

      const clientInformation = await resolveClientRegistration(
        { authorizationServerUrl: asUrl, metadata, redirectUri: options.redirectUri, scope, fetchFn: gf.fetch },
        options,
      );
      const state = randomBytes(32).toString('base64url');
      const resource = new URL(prm.resource);
      let started: { authorizationUrl: URL; codeVerifier: string };
      try {
        started = await startAuthorization(asUrl, {
          metadata,
          clientInformation: toSdkClientInformation(clientInformation),
          redirectUrl: options.redirectUri,
          state,
          resource,
          ...(scope ? { scope } : {}),
        });
      } catch {
        throw new McpOAuthError('incompatible_authorization_server');
      }
      this.assertBrowserUrl(started.authorizationUrl);
      return {
        authorizationUrl: started.authorizationUrl.href,
        pending: {
          connectionId: target.id,
          state,
          codeVerifier: started.codeVerifier,
          issuer: metadata.issuer,
          authorizationServerUrl: asUrl,
          authorizationServerMetadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
          clientInformation,
          redirectUri: options.redirectUri,
          resource: resource.href,
          scopes,
          network: target.network,
          expiresAt: this.now() + (this.deps.pendingTtlMs ?? 10 * 60_000),
        },
      };
    } finally {
      gf.close();
    }
  }

  async completeAuthorization(pending: McpPendingAuthorization, query: OAuthCallbackQuery): Promise<CompleteAuthorizationResult> {
    if (this.now() > pending.expiresAt) throw new McpOAuthError('pending_expired');
    if (!query.state || !constantTimeEqual(query.state, pending.state)) throw new McpOAuthError('state_mismatch');

    const metadata = pending.authorizationServerMetadata as unknown as AuthorizationServerMetadata;
    if (metadata.issuer !== pending.issuer || typeof metadata.token_endpoint !== 'string') throw new McpOAuthError('issuer_mismatch');
    const iss = query.iss ?? undefined;
    try {
      // RFC 9207 §2.4: reject a mismatching iss, and a missing one when the AS advertises support.
      validateAuthorizationResponseIssuer({
        iss,
        expectedIssuer: pending.issuer,
        issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
      });
    } catch (err) {
      if (err instanceof IssuerMismatchError) throw new McpOAuthError('issuer_mismatch');
      throw new McpOAuthError('issuer_mismatch');
    }
    if (query.error) throw new McpOAuthError('authorization_denied', query.error);
    if (!query.code) throw new McpOAuthError('missing_code');

    const gf = this.guardedFetch(pending.network);
    try {
      const raw = await exchangeAuthorization(pending.authorizationServerUrl, {
        metadata,
        clientInformation: toSdkClientInformation(pending.clientInformation),
        authorizationCode: query.code,
        ...(iss ? { iss } : {}),
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        resource: new URL(pending.resource),
        fetchFn: gf.fetch,
      });
      const tokens = tokensFromSdk(raw, this.now());
      const scopes = tokens.scope ? splitScope(tokens.scope) : pending.scopes;
      return {
        tokens,
        issuer: pending.issuer,
        clientInformation: pending.clientInformation,
        resource: pending.resource,
        scopes,
        tokenState: { ...tokens, issuer: pending.issuer, resource: pending.resource },
      };
    } catch (err) {
      throw mapOAuthHelperError(err, 'token_exchange_failed');
    } finally {
      gf.close();
    }
  }

  /** Refresh helper for callers that manage tokens themselves (the runtime path refreshes on 401 automatically). */
  async refresh(input: {
    issuer: string;
    clientInformation: Pick<McpOAuthClientInformation, 'clientId' | 'clientSecret' | 'clientSecretExpiresAt'>;
    refreshToken: string;
    resource?: string | undefined;
    network: McpNetwork;
  }): Promise<McpOAuthTokens> {
    const gf = this.guardedFetch(input.network);
    try {
      return await refreshOAuthTokens({ ...input, fetchFn: gf.fetch });
    } finally {
      gf.close();
    }
  }

  private guardedFetch(network: McpNetwork): GuardedFetch {
    return createGuardedFetch({ policy: this.deps.egress, network, limits: this.deps.limits, resolver: this.deps.resolver });
  }

  private pickAuthorizationServer(
    servers: readonly string[],
    target: Pick<McpConnectionTarget, 'auth'>,
    requested: string | undefined,
  ): string {
    if (servers.length === 0) throw new McpOAuthError('no_authorization_server');
    if (requested) {
      if (!servers.includes(requested)) throw new McpOAuthError('authorization_server_not_listed');
      return requested;
    }
    if (target.auth.strategy === 'OAUTH' && servers.includes(target.auth.issuer)) return target.auth.issuer;
    return servers[0] as string;
  }

  private async discoverAsMetadata(asUrl: string, gf: GuardedFetch): Promise<AuthorizationServerMetadata> {
    let metadata: AuthorizationServerMetadata | undefined;
    try {
      metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn: gf.fetch });
    } catch (err) {
      throw mapOAuthHelperError(err, 'no_authorization_server_metadata');
    }
    if (!metadata) throw new McpOAuthError('no_authorization_server_metadata');
    return metadata;
  }

  private assertCompatible(metadata: AuthorizationServerMetadata): void {
    // Spec MUST: refuse when PKCE S256 is not advertised (the SDK only checks when the field is present).
    if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new McpOAuthError('pkce_unsupported');
    if (!metadata.response_types_supported.includes('code')) throw new McpOAuthError('incompatible_authorization_server');
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new McpOAuthError('incompatible_authorization_server');
      }
      this.assertBrowserUrl(url);
    }
  }

  /** https everywhere; plain http only for hosts explicitly allowlisted for it (dev). Rejects javascript:/data: etc. */
  private assertBrowserUrl(url: URL): void {
    if (url.protocol === 'https:') return;
    if (url.protocol === 'http:' && hostMatches(url.hostname, this.deps.egress.allowInsecureHttpHosts)) return;
    throw new McpOAuthError('insecure_endpoint');
  }

  private assertRedirectUri(redirectUri: string): void {
    let url: URL;
    try {
      url = new URL(redirectUri);
    } catch {
      throw new McpOAuthError('invalid_redirect_uri');
    }
    const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
    if (!ok || url.hash) throw new McpOAuthError('invalid_redirect_uri');
  }
}

function splitScope(scope: string | undefined | null): string[] {
  return (scope ?? '').split(' ').filter(Boolean);
}
