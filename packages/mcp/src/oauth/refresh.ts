import { discoverAuthorizationServerMetadata, OAuthError, refreshAuthorization } from '@modelcontextprotocol/client';
import { McpOAuthError } from '../errors.js';
import type { FetchFn } from '../egress/guarded-fetch.js';
import type { McpOAuthClientInformation, McpOAuthTokens } from '../types.js';
import { mapOAuthHelperError } from './sdk-errors.js';
import { toSdkClientInformation, tokensFromSdk } from './token-state.js';

export interface RefreshTokensInput {
  /** Issuer the refresh token was minted by; its metadata is (re)discovered with the issuer-echo check. */
  issuer: string;
  clientInformation: Pick<McpOAuthClientInformation, 'clientId' | 'clientSecret' | 'clientSecretExpiresAt'>;
  refreshToken: string;
  /** RFC 8707 resource bound at authorization time. */
  resource?: string | undefined;
  fetchFn: FetchFn;
}

/** OAuth error codes meaning "this grant is dead, the user must re-authorize". */
const REAUTH_CODES = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope', 'invalid_target']);

/**
 * Refresh an access token with the SDK's `refreshAuthorization` (which keeps
 * the old refresh token when the AS does not rotate). The caller persists
 * the result (the client factory does so via `CredentialPort.onTokensRefreshed`).
 */
export async function refreshOAuthTokens(input: RefreshTokensInput): Promise<McpOAuthTokens> {
  let metadata;
  try {
    metadata = await discoverAuthorizationServerMetadata(input.issuer, { fetchFn: input.fetchFn });
  } catch (err) {
    throw mapOAuthHelperError(err, 'no_authorization_server_metadata');
  }
  if (!metadata) throw new McpOAuthError('no_authorization_server_metadata');
  try {
    const tokens = await refreshAuthorization(input.issuer, {
      metadata,
      clientInformation: toSdkClientInformation(input.clientInformation),
      refreshToken: input.refreshToken,
      ...(input.resource ? { resource: new URL(input.resource) } : {}),
      fetchFn: input.fetchFn,
    });
    return tokensFromSdk(tokens);
  } catch (err) {
    if (err instanceof OAuthError && REAUTH_CODES.has(err.code)) throw new McpOAuthError('refresh_rejected', err.code);
    throw mapOAuthHelperError(err, 'refresh_failed');
  }
}
