import type { Tool } from '@modelcontextprotocol/client';
import type { ToolInvocation, ToolOutcome, ToolProvider } from '@ocso/tools';
import { classifyMcpError } from '../client/classify-error.js';
import { createClientHandle, type McpClientHandle } from '../client/client-handle.js';
import type { McpConnectionTarget, McpServiceDeps } from '../types.js';
import { mapCallError, mapCallResult } from './result-mapper.js';

/** Header carrying OCSO's short-lived signed customer claims to trusted servers (docs/08 §4). */
export const CUSTOMER_CLAIMS_HEADER = 'X-OCSO-Customer-Claims';
/** Header carrying the per-call idempotency key (retry-safe writes). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** The admin-approved snapshot of a tool; `outputSchema` pins result validation to what was approved. */
export interface ApprovedToolDefinition {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
}

export interface McpToolProviderOptions {
  target: McpConnectionTarget;
  deps: McpServiceDeps;
  /** Only trusted connections receive customer claims. Default false. */
  trusted?: boolean | undefined;
  /** Lookup of approved definitions by server tool name (enables output-schema validation). */
  approvedTool?: ((toolName: string) => ApprovedToolDefinition | undefined) | undefined;
  /** Connect/negotiation deadline (bounded by each call's own timeout). Default 10 s. */
  connectTimeoutMs?: number | undefined;
  /** Notified when the server rejects credentials, so the caller can mark the connection AUTH_REQUIRED. */
  onAuthFailure?: ((connectionId: string) => void) | undefined;
}

const HEADER_VALUE = /^[\x21-\x7E]+$/;
const MAX_CLAIMS = 8_192;
const MAX_IDEMPOTENCY_KEY = 255;
const RESET_KINDS = new Set(['auth', 'credentials', 'network', 'negotiation', 'egress']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * ToolProvider for one MCP connection (ADR-014: OCSO executes tools; this is
 * called only after ToolAuthorizer allowed the call). Keeps one negotiated
 * client per connection and drops it after transport/auth failures so the
 * next call reconnects and re-resolves credentials. Never retries a call.
 *
 * Per-call headers (customer claims, idempotency key) are passed through the
 * SDK's per-request `RequestOptions.headers`, which the Streamable HTTP
 * transport applies to exactly that POST — no shared mutable state, so
 * concurrent calls cannot leak one customer's claims into another's request.
 */
export class McpToolProvider implements ToolProvider {
  readonly connectionId: string;
  private handle: Promise<McpClientHandle> | null = null;

  constructor(private readonly options: McpToolProviderOptions) {
    this.connectionId = options.target.id;
  }

  async invoke(call: ToolInvocation): Promise<ToolOutcome> {
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    if (!isPlainObject(call.args)) {
      return { status: 'FAILED', errorCategory: 'validation', message: 'Tool arguments must be a JSON object.', latencyMs: latency() };
    }
    const headers = this.callHeaders(call);
    if (headers === null) {
      return { status: 'FAILED', errorCategory: 'validation', message: 'Invalid per-call header value.', latencyMs: latency() };
    }
    const deadline = AbortSignal.timeout(Math.max(1, call.timeoutMs));
    const signal = call.signal ? AbortSignal.any([call.signal, deadline]) : deadline;
    const extraSecrets = call.customerClaims ? [call.customerClaims] : [];
    try {
      const handle = await raceAbort(this.getHandle(call.timeoutMs), signal);
      const approved = this.options.approvedTool?.(call.toolName);
      const result = await handle.client.callTool(
        { name: call.toolName, arguments: call.args },
        {
          timeout: Math.max(1, call.timeoutMs - latency()),
          signal,
          headers,
          ...(approved ? { toolDefinition: { ...approved, name: call.toolName } as Tool } : {}),
        },
      );
      return mapCallResult(result, latency(), [...handle.session.secrets(), ...extraSecrets]);
    } catch (err) {
      const { kind, httpStatus } = classifyMcpError(err);
      if (kind === 'auth' || kind === 'credentials') this.options.onAuthFailure?.(this.connectionId);
      // Reconnect (and re-resolve credentials) next time after auth/transport failures, or an expired 2025 session (404).
      if (RESET_KINDS.has(kind) || httpStatus === 404) await this.reset();
      return mapCallError(err, { timedOut: deadline.aborted, cancelled: call.signal?.aborted === true }, latency());
    }
  }

  /** Close the pooled client (e.g. connection disabled or config changed). */
  async close(): Promise<void> {
    await this.reset();
  }

  private callHeaders(call: ToolInvocation): Record<string, string> | null {
    const headers: Record<string, string> = {};
    if (call.idempotencyKey !== undefined) {
      if (call.idempotencyKey.length > MAX_IDEMPOTENCY_KEY || !HEADER_VALUE.test(call.idempotencyKey)) return null;
      headers[IDEMPOTENCY_KEY_HEADER] = call.idempotencyKey;
    }
    if (call.customerClaims !== undefined && this.options.trusted === true) {
      if (call.customerClaims.length > MAX_CLAIMS || !HEADER_VALUE.test(call.customerClaims)) return null;
      headers[CUSTOMER_CLAIMS_HEADER] = call.customerClaims;
    }
    return headers;
  }

  private getHandle(callTimeoutMs: number): Promise<McpClientHandle> {
    if (this.handle) return this.handle;
    const timeoutMs = Math.min(this.options.connectTimeoutMs ?? 10_000, Math.max(1, callTimeoutMs));
    const pending = (async () => {
      const handle = createClientHandle(this.options.target, this.options.deps);
      try {
        await handle.connect({ timeoutMs });
        return handle;
      } catch (err) {
        await handle.close();
        throw err;
      }
    })();
    this.handle = pending;
    pending.catch(() => {
      if (this.handle === pending) this.handle = null;
    });
    return pending;
  }

  private async reset(): Promise<void> {
    const current = this.handle;
    this.handle = null;
    if (!current) return;
    try {
      await (await current).close();
    } catch {
      // connect already failed and cleaned up
    }
  }
}
