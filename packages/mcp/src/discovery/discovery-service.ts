import { sanitizeToolDescription } from '@ocso/tools';
import { createClientHandle, type McpClientHandle } from '../client/client-handle.js';
import { toTypedMcpError } from '../client/to-typed-error.js';
import type { McpConnectionTarget, McpServiceDeps } from '../types.js';
import { normalizeTools, toolSetHash, type DiscoveredTool } from './tool-normalizer.js';

export interface McpDiscoveryResult {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  protocolEra: 'modern' | 'legacy';
  capabilities: Record<string, unknown>;
  /** Server `instructions`, sanitized; untrusted data, never to be placed in prompts unreviewed. */
  instructions: string | null;
  tools: DiscoveredTool[];
  toolSetHash: string;
  latencyMs: number;
  warnings: string[];
}

export interface DiscoverOptions {
  /** Connect + list deadline. Default 15 s. */
  timeoutMs?: number | undefined;
  /** Default 500. */
  maxTools?: number | undefined;
  /** Pages walked by `tools/list` pagination. Default 20. */
  maxPages?: number | undefined;
  /** Per-tool schema size cap. Default 64 KiB. */
  maxSchemaBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Discovery: connect with version negotiation, walk every `tools/list` page,
 * and return a normalized, hashed tool catalogue for admin review. Failures
 * are typed: `McpAuthRequiredError` (carrying RFC 9728 metadata so the UI
 * can offer OAuth or header auth), `EgressBlockedError`, `McpConnectionError`.
 */
export class McpDiscoveryService {
  constructor(private readonly deps: McpServiceDeps) {}

  async discover(target: McpConnectionTarget, options: DiscoverOptions = {}): Promise<McpDiscoveryResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const started = performance.now();
    const handle: McpClientHandle = createClientHandle(target, this.deps, { listMaxPages: options.maxPages ?? 20 });
    try {
      await handle.connect({ timeoutMs, signal: options.signal });
      const remaining = Math.max(1_000, timeoutMs - (performance.now() - started));
      const { tools } = await handle.client.listTools(undefined, {
        timeout: remaining,
        cacheMode: 'bypass',
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const normalized = normalizeTools(target.name, tools, {
        maxTools: options.maxTools ?? 500,
        maxSchemaBytes: options.maxSchemaBytes ?? 64 * 1024,
      });
      const server = handle.client.getServerVersion();
      const instructions = handle.client.getInstructions();
      return {
        serverName: server?.name ?? null,
        serverVersion: server?.version ?? null,
        protocolVersion: handle.protocolVersion(),
        protocolEra: handle.era() ?? 'legacy',
        capabilities: { ...(handle.client.getServerCapabilities() ?? {}) },
        instructions: instructions ? sanitizeToolDescription(instructions) : null,
        tools: normalized.tools,
        toolSetHash: toolSetHash(normalized.tools),
        latencyMs: Math.round(performance.now() - started),
        warnings: normalized.warnings,
      };
    } catch (err) {
      throw await toTypedMcpError(err, handle);
    } finally {
      await handle.close();
    }
  }
}
