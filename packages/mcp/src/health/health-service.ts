import { ProtocolError } from '@modelcontextprotocol/client';
import { createClientHandle, type McpClientHandle } from '../client/client-handle.js';
import { toTypedMcpError } from '../client/to-typed-error.js';
import { EgressBlockedError, McpAuthRequiredError, McpConnectionError } from '../errors.js';
import type { McpAuthRequired, McpConnectionTarget, McpServiceDeps } from '../types.js';

export type McpHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'AUTH_REQUIRED';

export interface McpHealthResult {
  status: McpHealthStatus;
  /** Round trip of the health request itself (`server/discover` or `ping`) on a warm connection. */
  latencyMs: number | null;
  /** Connect + version negotiation time. */
  connectMs: number | null;
  protocolVersion: string | null;
  protocolEra: 'modern' | 'legacy' | null;
  /** Short machine-friendly reason, safe to show (e.g. `ok`, `slow_response`, `timeout`, `http_503`). */
  detail: string;
  checkedAt: string;
  authRequired?: McpAuthRequired | undefined;
}

export interface HealthOptions {
  /** Default 5 s for connect and for the check. */
  timeoutMs?: number | undefined;
  /** Latency above which a responsive server is DEGRADED. Default 1500 ms. */
  degradedLatencyMs?: number | undefined;
}

/**
 * Health: `server/discover` on 2026-07-28 servers, `ping` only on 2025-era
 * servers (ADR-021; `ping` does not exist in the modern era). Never throws.
 */
export class McpHealthService {
  constructor(private readonly deps: McpServiceDeps) {}

  async health(target: McpConnectionTarget, options: HealthOptions = {}): Promise<McpHealthResult> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const degradedMs = options.degradedLatencyMs ?? 1_500;
    const checkedAt = new Date().toISOString();
    let handle: McpClientHandle | null = null;
    let connectMs: number | null = null;
    try {
      handle = createClientHandle(target, this.deps);
      const t0 = performance.now();
      await handle.connect({ timeoutMs });
      connectMs = Math.round(performance.now() - t0);
      const era = handle.era();
      const t1 = performance.now();
      let detail = 'ok';
      try {
        if (era === 'modern') await handle.client.discover({ timeout: timeoutMs });
        else await handle.client.ping({ timeout: timeoutMs });
      } catch (err) {
        // A JSON-RPC error answer still proves the server is up and speaking MCP.
        if (!(err instanceof ProtocolError)) throw err;
        detail = 'check_rejected';
      }
      const latencyMs = Math.round(performance.now() - t1);
      const slow = latencyMs > degradedMs;
      return {
        status: slow || detail !== 'ok' ? 'DEGRADED' : 'HEALTHY',
        latencyMs,
        connectMs,
        protocolVersion: handle.protocolVersion(),
        protocolEra: era,
        detail: slow && detail === 'ok' ? 'slow_response' : detail,
        checkedAt,
      };
    } catch (err) {
      return this.failure(err, handle, connectMs, checkedAt);
    } finally {
      await handle?.close();
    }
  }

  private async failure(err: unknown, handle: McpClientHandle | null, connectMs: number | null, checkedAt: string): Promise<McpHealthResult> {
    const base = { latencyMs: null, connectMs, protocolVersion: handle?.protocolVersion() ?? null, protocolEra: handle?.era() ?? null, checkedAt };
    let typed: unknown = err;
    try {
      if (handle) typed = await toTypedMcpError(err, handle);
    } catch {
      typed = err;
    }
    if (typed instanceof McpAuthRequiredError) {
      return { ...base, status: 'AUTH_REQUIRED', detail: typed.authRequired.reason, authRequired: typed.authRequired };
    }
    if (typed instanceof EgressBlockedError) return { ...base, status: 'DOWN', detail: `egress_blocked:${typed.reason}` };
    if (typed instanceof McpConnectionError) {
      const detail = typed.httpStatus ? `http_${typed.httpStatus}` : typed.failure;
      return { ...base, status: 'DOWN', detail };
    }
    return { ...base, status: 'DOWN', detail: 'error' };
  }
}
