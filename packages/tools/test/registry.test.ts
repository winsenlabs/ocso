import { describe, expect, it } from 'vitest';
import { ToolProviderRegistry, connectionToolSource, type FirstPartyTool, type ToolProvider, type ToolProviderSource } from '../src/index.js';

const provider = (connectionId: string | null): ToolProvider => ({
  connectionId,
  invoke: async () => ({ status: 'SUCCEEDED', output: { type: 'json', value: { connectionId } }, latencyMs: 1 }),
});

const tool = (name: string, over: Partial<FirstPartyTool> = {}): FirstPartyTool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  riskClass: 'READ',
  ...over,
});

const firstParty = (kind: string, tools: FirstPartyTool[]): ToolProviderSource => {
  const own = provider(null);
  return { kind, connectionBacked: false, tools, provider: async () => own };
};

const connections = connectionToolSource('conn', { forConnection: async (id) => provider(id) });

describe('ToolProviderRegistry', () => {
  it('resolves first-party tools to their source and connection tools to the connection source', async () => {
    const builtins = firstParty('first', [tool('ocso_a'), tool('ocso_b')]);
    const registry = new ToolProviderRegistry().register(builtins).register(connections);
    expect(registry.kinds()).toEqual(['first', 'conn']);
    expect(registry.firstPartyTools().map((t) => t.name)).toEqual(['ocso_a', 'ocso_b']);
    expect(registry.isFirstParty('ocso_a')).toBe(true);
    expect(registry.isFirstParty('conn__x')).toBe(false);
    expect((await registry.providerFor({ connectionId: null, name: 'ocso_b' })).connectionId).toBeNull();
    expect((await registry.providerFor({ connectionId: 'c-1', name: 'conn__x' })).connectionId).toBe('c-1');
  });

  it('fails closed for tools no source provides', async () => {
    const registry = new ToolProviderRegistry().register(firstParty('first', [tool('ocso_a')]));
    await expect(registry.providerFor({ connectionId: null, name: 'ocso_unknown' })).rejects.toThrow(/no tool source/);
    await expect(registry.providerFor({ connectionId: 'c-1', name: 'conn__x' })).rejects.toThrow(/no connection-backed/);
    await expect(connections.provider(null)).rejects.toThrow(/need a connection/);
  });

  it('rejects duplicate kinds, duplicate tool names and a second connection source', () => {
    const registry = new ToolProviderRegistry().register(firstParty('first', [tool('ocso_a')])).register(connections);
    expect(() => registry.register(firstParty('first', []))).toThrow(/already registered/);
    expect(() => registry.register(firstParty('second', [tool('ocso_a')]))).toThrow(/already provided by first/);
    expect(() => registry.register(connectionToolSource('conn2', { forConnection: async (id) => provider(id) }))).toThrow(/already served by conn/);
    expect(registry.has('second')).toBe(false);
  });

  it('refuses first-party tools that could never be confirmed or named safely', () => {
    const sensitive = tool('ocso_pay', { riskClass: 'SENSITIVE' as FirstPartyTool['riskClass'] });
    expect(() => new ToolProviderRegistry().register(firstParty('first', [sensitive]))).toThrow(/cannot be SENSITIVE/);
    expect(() => new ToolProviderRegistry().register(firstParty('first', [tool('bad name!')]))).toThrow(/not provider-safe/);
    expect(() => new ToolProviderRegistry().register({ ...connections, tools: [tool('ocso_a')] })).toThrow(/cannot ship first-party tools/);
  });
});
