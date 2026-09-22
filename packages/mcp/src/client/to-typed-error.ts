import { InsufficientScopeError } from '@modelcontextprotocol/client';
import { buildAuthRequired, type AuthChallenge } from '../auth/challenge.js';
import { McpAuthRequiredError, McpConnectionError, McpCredentialError, McpOAuthError } from '../errors.js';
import type { McpAuthRequired } from '../types.js';
import { classifyMcpError } from './classify-error.js';
import type { McpClientHandle } from './client-handle.js';

function challengeFor(err: unknown, handle: McpClientHandle): AuthChallenge | null {
  if (err instanceof InsufficientScopeError) {
    return {
      status: 403,
      resourceMetadataUrl: err.resourceMetadataUrl?.href ?? null,
      scope: err.requiredScope ?? null,
      error: 'insufficient_scope',
    };
  }
  return handle.challenges.last;
}

function credentialReason(err: unknown): McpAuthRequired['reason'] | null {
  if (err instanceof McpCredentialError) return err.reason === 'issuer_mismatch' ? 'issuer_mismatch' : 'credentials_missing';
  if (err instanceof McpOAuthError) return err.reason === 'issuer_mismatch' ? 'issuer_mismatch' : 'token_rejected';
  return null;
}

/**
 * Convert any failure from a connect/list/check into a typed, safe error:
 * `McpAuthRequiredError` (with RFC 9728 metadata for the admin UI),
 * `EgressBlockedError`, `McpConnectionError`, or the caller's abort reason.
 */
export async function toTypedMcpError(err: unknown, handle: McpClientHandle): Promise<Error> {
  const c = classifyMcpError(err);
  switch (c.kind) {
    case 'auth':
    case 'credentials': {
      const challenge = challengeFor(c.error, handle);
      const info = await buildAuthRequired(handle.target.url, challenge, handle.session.sendsCredentials, handle.plainFetch);
      const reason = credentialReason(c.error);
      return new McpAuthRequiredError(reason ? { ...info, reason } : info);
    }
    case 'egress':
      return c.error as Error;
    case 'network':
      return new McpConnectionError('unreachable');
    case 'timeout':
      return new McpConnectionError('timeout');
    case 'aborted':
      return c.error instanceof Error ? c.error : new McpConnectionError('timeout');
    case 'http':
      return new McpConnectionError('http_error', c.httpStatus);
    case 'negotiation':
      return new McpConnectionError('negotiation_failed', c.httpStatus);
    default:
      return new McpConnectionError('protocol_error');
  }
}
