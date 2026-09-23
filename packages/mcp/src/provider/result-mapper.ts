import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ToolOutcome } from '@ocso/tools';
import { classifyMcpError } from '../client/classify-error.js';

type FailedOutcome = Extract<ToolOutcome, { status: 'FAILED' }>;

const MAX_TEXT_OUTPUT = 100_000;
const MAX_ERROR_TEXT = 500;
const REDACTED = '[REDACTED]';
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INPUT_VALIDATION = /^Input validation error\b/;

/** Replace every occurrence of known secret values (tokens, claims) in text. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(REDACTED);
  return out;
}

function redactDeep(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (secrets.length === 0 || depth > 32) return value;
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets, depth + 1)]));
  }
  return value;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/** Flatten MCP content blocks to text; non-text media is summarized, never inlined. */
export function contentText(content: CallToolResult['content']): string {
  return (content ?? [])
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'resource':
          return 'text' in block.resource && typeof block.resource.text === 'string' ? block.resource.text : `[resource ${block.resource.uri}]`;
        case 'resource_link':
          return `[resource_link ${block.uri}]`;
        default:
          return `[${block.type} content omitted]`;
      }
    })
    .join('\n');
}

/** Map a completed `tools/call` result to a ToolOutcome. */
export function mapCallResult(result: CallToolResult, latencyMs: number, secrets: readonly string[]): ToolOutcome {
  if (result.isError) {
    const text = truncate(redactSecrets(contentText(result.content).replace(CONTROL, '').trim(), secrets), MAX_ERROR_TEXT);
    return {
      status: 'FAILED',
      // SDK servers (v1.2x+/v2 McpServer) report schema-invalid arguments as an isError result with this prefix.
      errorCategory: INPUT_VALIDATION.test(text) ? 'validation' : 'tool_rejected',
      message: text ? `The tool reported an error: ${text}` : 'The tool reported an error.',
      latencyMs,
    };
  }
  if (result.structuredContent !== undefined) {
    return { status: 'SUCCEEDED', output: { type: 'json', value: redactDeep(result.structuredContent, secrets) }, latencyMs };
  }
  return {
    status: 'SUCCEEDED',
    output: { type: 'text', value: truncate(redactSecrets(contentText(result.content), secrets), MAX_TEXT_OUTPUT) },
    latencyMs,
  };
}

function failed(errorCategory: FailedOutcome['errorCategory'], message: string, latencyMs: number): FailedOutcome {
  return { status: 'FAILED', errorCategory, message, latencyMs };
}

export interface CallFailureContext {
  /** Our own deadline fired. */
  timedOut: boolean;
  /** The caller's AbortSignal fired (the SDK reports both as REQUEST_TIMEOUT, so signals decide). */
  cancelled: boolean;
}

/**
 * Map a thrown failure to a ToolOutcome with a SAFE, fixed message: raw
 * exception text, server bodies and credentials never leave this function.
 * Note: `timeout`/`tool_unavailable` after the request was sent mean the
 * call MAY have executed — retry writes only with an idempotency key.
 */
export function mapCallError(err: unknown, ctx: CallFailureContext, latencyMs: number): FailedOutcome {
  if (ctx.cancelled) return failed('internal', 'The tool call was cancelled.', latencyMs);
  const c = classifyMcpError(err);
  switch (c.kind) {
    case 'timeout':
      return failed('timeout', 'The tool did not respond in time.', latencyMs);
    case 'aborted':
      return ctx.timedOut
        ? failed('timeout', 'The tool did not respond in time.', latencyMs)
        : failed('internal', 'The tool call was cancelled.', latencyMs);
    case 'auth':
    case 'credentials':
      return failed('tool_unavailable', 'The tool connection needs to be re-authorized by an administrator.', latencyMs);
    case 'egress':
      return failed('tool_unavailable', 'The tool server is blocked by the outbound network policy.', latencyMs);
    case 'network':
    case 'negotiation':
      return failed('tool_unavailable', 'The tool server could not be reached.', latencyMs);
    case 'server_error':
      return failed('tool_unavailable', 'The tool server failed to process the request.', latencyMs);
    case 'http': {
      const status = c.httpStatus ?? 0;
      if (status >= 500 || status === 429 || status === 404 || status === 408) {
        return failed('tool_unavailable', `The tool server is unavailable (HTTP ${status}).`, latencyMs);
      }
      return failed('tool_rejected', `The tool server rejected the request (HTTP ${status}).`, latencyMs);
    }
    case 'tool_input':
      return failed('validation', 'The tool server rejected the call as invalid (unknown tool or invalid arguments).', latencyMs);
    case 'invalid_output':
      return failed('tool_rejected', 'The tool returned output that does not match its approved schema.', latencyMs);
    case 'protocol':
      return failed('tool_rejected', 'The tool server returned an invalid or unsupported response.', latencyMs);
    default:
      return failed('internal', 'Unexpected error while calling the tool.', latencyMs);
  }
}
