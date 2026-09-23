import {
  checkResourceAllowed,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  resourceUrlFromServerUrl,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/client';
import { EgressBlockedError, McpNetworkError } from '../errors.js';
import type { FetchFn } from '../egress/guarded-fetch.js';
import type { McpAuthRequired } from '../types.js';

/** A parsed `WWW-Authenticate: Bearer …` challenge from a 401/403. All values are server-controlled. */
export interface AuthChallenge {
  status: number;
  resourceMetadataUrl: string | null;
  scope: string | null;
  error: string | null;
}

export function parseChallenge(status: number, header: string | null): AuthChallenge {
  const empty: AuthChallenge = { status, resourceMetadataUrl: null, scope: null, error: null };
  if (!header) return empty;
  try {
    const p = extractWWWAuthenticateParams(new Response(null, { headers: { 'www-authenticate': header } }));
    return { status, resourceMetadataUrl: p.resourceMetadataUrl?.href ?? null, scope: p.scope ?? null, error: p.error ?? null };
  } catch {
    return empty;
  }
}

/** Wraps a fetch and remembers the last 401/403 challenge (the SDK consumes the response itself). */
export class ChallengeRecorder {
  last: AuthChallenge | null = null;

  wrap(fetchFn: FetchFn): FetchFn {
    return async (input, init) => {
      const res = await fetchFn(input, init);
      if (res.status === 401 || res.status === 403) this.last = parseChallenge(res.status, res.headers.get('www-authenticate'));
      return res;
    };
  }
}

/** Unauthenticated POST to the MCP endpoint to read its auth challenge; `null` when it does not demand auth. */
export async function probeAuthChallenge(serverUrl: string, fetchFn: FetchFn): Promise<AuthChallenge | null> {
  const res = await fetchFn(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.status === 401 || res.status === 403 ? parseChallenge(res.status, res.headers.get('www-authenticate')) : null;
}

/**
 * RFC 9728 discovery: the challenge's `resource_metadata` when present, else
 * the path-aware then root well-known URLs (SDK). Returns `null` when the
 * server publishes no PRM. Egress/network failures propagate.
 */
export async function discoverResourceMetadata(
  serverUrl: string,
  challenge: AuthChallenge | null,
  fetchFn: FetchFn,
): Promise<OAuthProtectedResourceMetadata | null> {
  try {
    return await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {},
      fetchFn,
    );
  } catch (err) {
    if (err instanceof EgressBlockedError || err instanceof McpNetworkError) throw err;
    return null;
  }
}

export function resourceMatchesServer(serverUrl: string, prm: OAuthProtectedResourceMetadata): boolean {
  try {
    return checkResourceAllowed({ requestedResource: resourceUrlFromServerUrl(serverUrl), configuredResource: prm.resource });
  } catch {
    return false;
  }
}

function reasonFor(challenge: AuthChallenge | null, sentCredentials: boolean): McpAuthRequired['reason'] {
  if (challenge?.status === 403) return challenge.error === 'insufficient_scope' ? 'insufficient_scope' : 'forbidden';
  return sentCredentials ? 'token_rejected' : 'unauthorized';
}

/** Build the typed "auth required" payload an admin UI needs to start (re-)authentication. */
export async function buildAuthRequired(
  serverUrl: string,
  challenge: AuthChallenge | null,
  sentCredentials: boolean,
  fetchFn: FetchFn,
): Promise<McpAuthRequired> {
  const prm = await discoverResourceMetadata(serverUrl, challenge, fetchFn).catch(() => null);
  const servers = prm?.authorization_servers ?? [];
  return {
    reason: reasonFor(challenge, sentCredentials),
    resourceMetadataUrl: challenge?.resourceMetadataUrl ?? null,
    resource: prm?.resource ?? null,
    authorizationServers: [...servers],
    scopesSupported: [...(prm?.scopes_supported ?? [])],
    challengedScope: challenge?.scope ?? null,
    oauthAvailable: prm !== null && servers.length > 0 && resourceMatchesServer(serverUrl, prm),
  };
}
