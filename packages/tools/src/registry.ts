import type { ToolProvider } from './provider.js';
import type { ToolRiskClass } from './types.js';

/**
 * A tool shipped in code by a first-party source (the built-in OCSO tools).
 * Every agent gets it without an approval record; each call still goes
 * through authorizeToolCall and the tool_calls audit like an MCP tool.
 */
export interface FirstPartyTool {
  /** Model-facing name, unique across sources ([a-zA-Z0-9_-], at most 64 chars). */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Side-effect class. SENSITIVE is not allowed: a first-party call runs
   * inside the agent's turn and has no human-confirmation path.
   */
  riskClass: Exclude<ToolRiskClass, 'SENSITIVE'>;
}

/** Per-connection provider factory (MCP: one pooled client per approved connection). */
export interface ConnectionToolProviders {
  forConnection(connectionId: string): Promise<ToolProvider>;
}

/**
 * A registered family of tools. The connection-backed source (MCP) serves
 * tools a Tech admin approved into the `tools` table, one provider per
 * connection; first-party sources ship a fixed tool list and one provider.
 */
export interface ToolProviderSource {
  /** Registry key. Core code never names one. */
  readonly kind: string;
  /** True for the source that serves admin-managed connections (at most one is registered). */
  readonly connectionBacked: boolean;
  /** Fixed first-party tools; empty for the connection-backed source. */
  readonly tools: readonly FirstPartyTool[];
  /** Provider for one connection (connection-backed) or for the source's own tools (`null`). */
  provider(connectionId: string | null): Promise<ToolProvider>;
}

/** Wrap a per-connection factory (MCP) as the registry's connection-backed source. */
export function connectionToolSource(kind: string, connections: ConnectionToolProviders): ToolProviderSource {
  return {
    kind,
    connectionBacked: true,
    tools: [],
    provider: (connectionId) =>
      connectionId === null ? Promise.reject(new Error(`${kind} tools need a connection`)) : connections.forConnection(connectionId),
  };
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Tool providers are registered, never switched on (build rule §4). The
 * runtime resolves every call's provider here — MCP and built-in alike —
 * after the one authorization and audit path in ToolRunner.
 */
export class ToolProviderRegistry {
  private readonly sources = new Map<string, ToolProviderSource>();
  private readonly owners = new Map<string, { source: ToolProviderSource; tool: FirstPartyTool }>();
  private connections: ToolProviderSource | null = null;

  register(source: ToolProviderSource): this {
    if (this.sources.has(source.kind)) throw new Error(`tool provider source ${source.kind} already registered`);
    if (source.connectionBacked && this.connections) throw new Error(`tool connections are already served by ${this.connections.kind}`);
    if (source.connectionBacked && source.tools.length) throw new Error(`connection-backed source ${source.kind} cannot ship first-party tools`);
    for (const tool of source.tools) {
      if (!TOOL_NAME.test(tool.name)) throw new Error(`tool name ${tool.name} is not provider-safe`);
      if ((tool.riskClass as ToolRiskClass) === 'SENSITIVE') throw new Error(`first-party tool ${tool.name} cannot be SENSITIVE`);
      const owner = this.owners.get(tool.name);
      if (owner) throw new Error(`tool ${tool.name} is already provided by ${owner.source.kind}`);
    }
    this.sources.set(source.kind, source);
    for (const tool of source.tools) this.owners.set(tool.name, { source, tool });
    if (source.connectionBacked) this.connections = source;
    return this;
  }

  get(kind: string): ToolProviderSource {
    const source = this.sources.get(kind);
    if (!source) throw new Error(`no tool provider source registered for ${kind}`);
    return source;
  }

  has(kind: string): boolean {
    return this.sources.has(kind);
  }

  kinds(): string[] {
    return [...this.sources.keys()];
  }

  /** First-party tools of every registered source, in registration order. */
  firstPartyTools(): FirstPartyTool[] {
    return [...this.owners.values()].map((o) => o.tool);
  }

  isFirstParty(name: string): boolean {
    return this.owners.has(name);
  }

  /**
   * The provider that executes one tool: its connection's provider for
   * connection tools, its owning source's provider for first-party tools.
   */
  async providerFor(tool: { connectionId: string | null; name: string }): Promise<ToolProvider> {
    if (tool.connectionId !== null) {
      if (!this.connections) throw new Error('no connection-backed tool source registered');
      return this.connections.provider(tool.connectionId);
    }
    const owner = this.owners.get(tool.name);
    if (!owner) throw new Error(`no tool source provides ${tool.name}`);
    return owner.source.provider(null);
  }
}
