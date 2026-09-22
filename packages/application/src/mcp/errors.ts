import { DomainError, ErrorCategory, conflict, isDomainError, validation } from '@ocso/domain';
import { McpOAuthError } from '@ocso/mcp';

/**
 * Typed errors of the MCP connection manager. Messages are safe to show an
 * admin and to log: they never carry tokens, secret values or raw server text.
 */

export const connectionDisabled = (id: string) => conflict('mcp_connection_disabled', `MCP connection ${id} is disabled`);

export const connectionNotDiscovered = (id: string) =>
  conflict('mcp_connection_not_discovered', `MCP connection ${id} has no successful tool discovery yet`);

export const connectionAuthRequired = (id: string) =>
  conflict('mcp_connection_auth_required', `MCP connection ${id} must be authenticated first`);

export const connectionNameTaken = (name: string) => conflict('mcp_connection_name_taken', `An MCP connection named ${name} already exists`);

export const noToolsApproved = () => validation('mcp_no_tools_approved', 'Approve at least one tool before approving the connection');

export const unknownTools = (ids: readonly string[]) =>
  validation('mcp_unknown_tools', 'Some tools do not belong to this connection or were removed', { toolIds: [...ids] });

export const notATemplate = (id: string) => validation('mcp_not_a_template', `MCP connection ${id} is not a published user-scope template`);

/** Why an OAuth callback failed; `reason` is a stable, URL-safe code for the redirect. */
export class McpOAuthCallbackError extends DomainError {
  constructor(
    readonly reason: string,
    readonly connectionId: string | null,
  ) {
    super(ErrorCategory.AUTHENTICATION, 'mcp_oauth_callback_failed', `OAuth callback failed (${reason})`, { reason, connectionId });
  }
}

const REASON = /^[a-z0-9_]{1,64}$/;

/** Map any failure during the callback to a stable reason code (never raw text). */
export function callbackFailure(err: unknown, connectionId: string | null): McpOAuthCallbackError {
  if (err instanceof McpOAuthCallbackError) return err;
  let reason = 'internal';
  if (err instanceof McpOAuthError) reason = err.reason;
  else if (isDomainError(err)) reason = err.code;
  return new McpOAuthCallbackError(REASON.test(reason) ? reason : 'internal', connectionId);
}
