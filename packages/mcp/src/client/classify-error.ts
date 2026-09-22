import {
  InsufficientScopeError,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { EgressBlockedError, McpAuthRequiredError, McpCredentialError, McpNetworkError, McpOAuthError } from '../errors.js';

export type McpFailureKind =
  | 'auth'
  | 'credentials'
  | 'egress'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'negotiation'
  | 'tool_input'
  | 'invalid_output'
  | 'server_error'
  | 'protocol'
  | 'unknown';

export interface ClassifiedFailure {
  kind: McpFailureKind;
  httpStatus: number | null;
  /** The most specific typed error found in the cause chain. */
  error: unknown;
}

/** Messages the SDK itself produces when validating structuredContent against an outputSchema (2.0.0). */
const OUTPUT_VALIDATION = [/has an output schema but did not return structured content/, /does not match the tool's output schema/, /Failed to validate structured content/, /has an invalid outputSchema/];

function causes(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur !== undefined && cur !== null && !chain.includes(cur); i++) {
    chain.push(cur);
    const data = cur instanceof SdkError ? cur.data : undefined;
    const dataCause = data && typeof data === 'object' && 'cause' in data ? (data as { cause: unknown }).cause : undefined;
    cur = cur instanceof Error && cur.cause !== undefined ? cur.cause : dataCause;
  }
  return chain;
}

function classifyOne(e: unknown): Omit<ClassifiedFailure, 'error'> | null {
  if (e instanceof EgressBlockedError) return { kind: 'egress', httpStatus: null };
  if (e instanceof McpNetworkError) return { kind: e.reason === 'timeout' ? 'timeout' : 'network', httpStatus: null };
  if (e instanceof McpCredentialError) return { kind: 'credentials', httpStatus: null };
  if (e instanceof McpAuthRequiredError) return { kind: 'auth', httpStatus: null };
  if (e instanceof McpOAuthError) {
    // A transient refresh failure is an availability problem; anything else needs an admin to re-authorize.
    return { kind: e.reason === 'refresh_failed' ? 'network' : 'auth', httpStatus: null };
  }
  if (e instanceof UnauthorizedError || e instanceof InsufficientScopeError) return { kind: 'auth', httpStatus: null };
  if (e instanceof SdkHttpError) {
    if (e.status === 401 || e.status === 403) return { kind: 'auth', httpStatus: e.status };
    if (e.code === SdkErrorCode.EraNegotiationFailed && e.status < 500) return { kind: 'negotiation', httpStatus: e.status };
    return { kind: 'http', httpStatus: e.status };
  }
  if (e instanceof SdkError) {
    switch (e.code) {
      case SdkErrorCode.RequestTimeout:
        return { kind: 'timeout', httpStatus: null };
      case SdkErrorCode.ConnectionClosed:
      case SdkErrorCode.SendFailed:
      case SdkErrorCode.NotConnected:
        return { kind: 'network', httpStatus: null };
      case SdkErrorCode.EraNegotiationFailed:
        return null; // look at the cause (network vs. protocol)
      default:
        return { kind: 'protocol', httpStatus: null };
    }
  }
  if (e instanceof ProtocolError) {
    if (OUTPUT_VALIDATION.some((re) => re.test(e.message))) return { kind: 'invalid_output', httpStatus: null };
    if (e.code === ProtocolErrorCode.InvalidParams) return { kind: 'tool_input', httpStatus: null };
    if (e.code === ProtocolErrorCode.InternalError) return { kind: 'server_error', httpStatus: null };
    return { kind: 'protocol', httpStatus: null };
  }
  if (e instanceof Error && e.name === 'TimeoutError') return { kind: 'timeout', httpStatus: null };
  if (e instanceof Error && e.name === 'AbortError') return { kind: 'aborted', httpStatus: null };
  return null;
}

/** Walk the cause chain (incl. `SdkError.data.cause`) and return the most specific classification. */
export function classifyMcpError(err: unknown): ClassifiedFailure {
  const chain = causes(err);
  // Typed OCSO errors anywhere in the chain win (they explain SDK wrappers such as EraNegotiationFailed).
  for (const e of chain) {
    if (e instanceof EgressBlockedError || e instanceof McpNetworkError || e instanceof McpCredentialError || e instanceof McpOAuthError) {
      return { ...(classifyOne(e) as Omit<ClassifiedFailure, 'error'>), error: e };
    }
  }
  for (const e of chain) {
    const c = classifyOne(e);
    if (c) return { ...c, error: e };
  }
  const negotiation = chain.find((e) => e instanceof SdkError && e.code === SdkErrorCode.EraNegotiationFailed);
  if (negotiation) return { kind: 'negotiation', httpStatus: null, error: negotiation };
  return { kind: 'unknown', httpStatus: null, error: err };
}
