import type { McpNetwork, McpOAuthClientInformation, McpOAuthTokens, StoredOAuthTokenState } from '../types.js';
import type { ClientRegistrationOptions } from './registration.js';

export interface BeginAuthorizationOptions extends ClientRegistrationOptions {
  /** OCSO's callback URL, e.g. `https://ocso.example.com/api/mcp/oauth/callback` (https, or http on loopback for dev). */
  redirectUri: string;
  /** Explicit scopes (e.g. a step-up union). Default: target scopes → challenge scope → PRM `scopes_supported`. */
  scopes?: readonly string[] | undefined;
  /** Pick one of the PRM-listed authorization servers. Default: the target's configured issuer if listed, else the first. */
  authorizationServer?: string | undefined;
}

/**
 * Server-side record of an in-flight authorization. The API layer MUST
 * persist it server-side only (it contains the PKCE verifier and possibly a
 * client secret), treat it as single-use, and delete it on completion or
 * expiry. Never send it to the browser.
 */
export interface McpPendingAuthorization {
  connectionId: string;
  state: string;
  codeVerifier: string;
  /** AS issuer recorded at redirect time (mix-up defence, credential keying). */
  issuer: string;
  authorizationServerUrl: string;
  /** Validated RFC 8414 metadata captured at redirect time (plain JSON). */
  authorizationServerMetadata: Readonly<Record<string, unknown>>;
  clientInformation: McpOAuthClientInformation;
  redirectUri: string;
  /** RFC 8707 resource sent in the authorize request (sent again at token exchange). */
  resource: string;
  scopes: string[];
  network: McpNetwork;
  /** Epoch ms. */
  expiresAt: number;
}

export interface BeginAuthorizationResult {
  /** Where to send the admin's browser (validated https / allowlisted scheme+host). */
  authorizationUrl: string;
  pending: McpPendingAuthorization;
}

/** Query parameters of the redirect back to OCSO. `error_description` is deliberately not accepted. */
export interface OAuthCallbackQuery {
  code?: string | null | undefined;
  state?: string | null | undefined;
  iss?: string | null | undefined;
  error?: string | null | undefined;
}

export interface CompleteAuthorizationResult {
  tokens: McpOAuthTokens;
  issuer: string;
  clientInformation: McpOAuthClientInformation;
  resource: string;
  /** Granted scopes (token `scope`, else the requested ones). */
  scopes: string[];
  /** What the connection's `tokenRef` must store (serialize with `serializeOAuthTokenState`). */
  tokenState: StoredOAuthTokenState;
}
