import { InsecureTokenEndpointError, IssuerMismatchError, OAuthError, RegistrationRejectedError } from '@modelcontextprotocol/client';
import { EgressBlockedError, McpNetworkError, McpOAuthError, type OAuthFailureReason } from '../errors.js';

/**
 * Map an SDK OAuth-helper failure to a typed, safe {@link McpOAuthError}.
 * Egress/network errors keep their own types. Never copies SDK messages
 * (they may embed server bodies or attacker-controlled callback values).
 */
export function mapOAuthHelperError(err: unknown, fallback: OAuthFailureReason): Error {
  if (err instanceof EgressBlockedError || err instanceof McpNetworkError || err instanceof McpOAuthError) return err;
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : undefined;
  if (cause instanceof EgressBlockedError || cause instanceof McpNetworkError) return cause;
  if (err instanceof IssuerMismatchError) return new McpOAuthError('issuer_mismatch');
  if (err instanceof InsecureTokenEndpointError) return new McpOAuthError('insecure_endpoint');
  if (err instanceof RegistrationRejectedError) return new McpOAuthError('registration_rejected', registrationErrorCode(err.body));
  if (err instanceof OAuthError) return new McpOAuthError(fallback, err.code);
  return new McpOAuthError(fallback);
}

function registrationErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    // non-JSON body: no code
  }
  return null;
}
