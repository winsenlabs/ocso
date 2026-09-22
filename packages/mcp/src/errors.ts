import { DomainError, ErrorCategory } from '@ocso/domain';
import type { McpAuthRequired } from './types.js';

/**
 * Typed errors for MCP connectivity. Messages are safe to show an admin and
 * to log: they never contain tokens, secrets, raw server bodies or
 * attacker-controlled OAuth `error_description` text.
 */

export type EgressBlockReason =
  | 'invalid_url'
  | 'insecure_scheme'
  | 'credentials_in_url'
  | 'forbidden_address'
  | 'private_address'
  | 'dns_failure'
  | 'too_many_redirects'
  | 'redirect_not_allowed';

/** An outbound request was refused by the SSRF / egress policy. */
export class EgressBlockedError extends DomainError {
  constructor(
    readonly reason: EgressBlockReason,
    readonly host: string | null,
  ) {
    super(ErrorCategory.POLICY_DENIED, 'mcp_egress_blocked', `Outbound request blocked by egress policy (${reason})`, {
      reason,
      host,
    });
  }
}

export type NetworkFailureReason = 'connect_failed' | 'timeout' | 'response_too_large' | 'reset';

/** Transport-level failure below HTTP (DNS/TCP/TLS/timeouts/size cap). */
export class McpNetworkError extends DomainError {
  constructor(
    readonly reason: NetworkFailureReason,
    readonly errno: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(
      reason === 'timeout' ? ErrorCategory.TIMEOUT : ErrorCategory.TOOL_UNAVAILABLE,
      'mcp_network_error',
      `Network error contacting MCP server (${errno ?? reason})`,
      { reason, errno },
    );
    if (options && 'cause' in options) Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
  }
}

/** The server requires (re-)authentication; carries what is needed to start OAuth, if available. */
export class McpAuthRequiredError extends DomainError {
  constructor(readonly authRequired: McpAuthRequired) {
    super(ErrorCategory.AUTHENTICATION, 'mcp_auth_required', `MCP server requires authentication (${authRequired.reason})`, {
      reason: authRequired.reason,
      oauthAvailable: authRequired.oauthAvailable,
    });
  }
}

/** A credential reference could not be resolved or was malformed. */
export class McpCredentialError extends DomainError {
  constructor(readonly reason: 'unresolvable' | 'malformed' | 'issuer_mismatch') {
    super(ErrorCategory.AUTHENTICATION, 'mcp_credentials_unavailable', `MCP credentials unavailable (${reason})`, { reason });
  }
}

export type McpConnectionFailure = 'unreachable' | 'timeout' | 'http_error' | 'protocol_error' | 'negotiation_failed';

/** The server could not be reached or did not speak MCP acceptably. */
export class McpConnectionError extends DomainError {
  constructor(
    readonly failure: McpConnectionFailure,
    readonly httpStatus: number | null = null,
  ) {
    super(
      failure === 'timeout' ? ErrorCategory.TIMEOUT : ErrorCategory.TOOL_UNAVAILABLE,
      'mcp_connection_failed',
      httpStatus ? `MCP server connection failed (${failure}, HTTP ${httpStatus})` : `MCP server connection failed (${failure})`,
      { failure, httpStatus },
    );
  }
}

export type OAuthFailureReason =
  | 'no_resource_metadata'
  | 'no_authorization_server'
  | 'authorization_server_not_listed'
  | 'no_authorization_server_metadata'
  | 'issuer_mismatch'
  | 'pkce_unsupported'
  | 'resource_mismatch'
  | 'insecure_endpoint'
  | 'invalid_client_metadata_url'
  | 'registration_unavailable'
  | 'registration_rejected'
  | 'pending_expired'
  | 'state_mismatch'
  | 'authorization_denied'
  | 'missing_code'
  | 'token_exchange_failed'
  | 'refresh_unavailable'
  | 'refresh_rejected'
  | 'refresh_failed';

const OAUTH_CODE = /^[a-z0-9_.-]{1,64}$/i;

/** Every OAuth-flow failure; `reason` is the stable discriminant for the API/UI. */
export class McpOAuthError extends DomainError {
  constructor(
    readonly reason: OAuthFailureReason,
    /** OAuth `error` code from the AS (e.g. `invalid_grant`) when trustworthy; never `error_description`. */
    readonly oauthError: string | null = null,
  ) {
    const safeCode = oauthError && OAUTH_CODE.test(oauthError) ? oauthError : null;
    super(
      reason === 'pending_expired' || reason === 'state_mismatch' || reason === 'missing_code'
        ? ErrorCategory.VALIDATION
        : ErrorCategory.AUTHENTICATION,
      `mcp_oauth_${reason}`,
      safeCode ? `OAuth flow failed (${reason}: ${safeCode})` : `OAuth flow failed (${reason})`,
      { reason, oauthError: safeCode },
    );
  }
}

export const isEgressBlocked = (e: unknown): e is EgressBlockedError => e instanceof EgressBlockedError;
export const isMcpAuthRequired = (e: unknown): e is McpAuthRequiredError => e instanceof McpAuthRequiredError;
