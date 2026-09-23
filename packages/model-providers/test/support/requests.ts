import type { MediaResolver, ToolSpec } from '@ocso/domain';
import type { ModelRequest, ModelStreamEvent, ProviderKind, ProviderRuntimeConfig } from '../../src/contract/types.js';

/** Shared neutral request pieces used by every provider contract test. */

// Adapters surface SDK warnings on ModelResult.warnings; keep test output clean.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

export const media: MediaResolver = {
  async resolve(blobKey) {
    return { data: new TextEncoder().encode(`bytes-of-${blobKey}`), mimeType: 'image/png' };
  },
};

const objectSchema = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

/** Deliberately NOT in name order: adapters must send them sorted. */
export const TOOLS: ToolSpec[] = [
  { name: 'zeta_lookup', description: 'Zeta lookup', inputSchema: objectSchema({ q: { type: 'string' } }, ['q']) },
  {
    name: 'core__get_balance',
    description: 'Get the account balance',
    inputSchema: objectSchema({ accountId: { type: 'string' } }, ['accountId']),
  },
  { name: 'alpha_ping', description: 'Alpha ping', inputSchema: objectSchema({}, []) },
];

export const SORTED_TOOL_NAMES = ['alpha_ping', 'core__get_balance', 'zeta_lookup'];

/**
 * Three compiler breakpoints: AGENT_PREFIX after the stable system blocks,
 * CONVERSATION_CONTEXT after customer context, HISTORY after answered history.
 */
export function standardRequest(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: 'TURN',
    system: [
      { key: 'runtime_contract', text: 'You are an OCSO virtual agent.', stable: true },
      { key: 'identity', text: 'You are Maya from Acme Bank.', stable: true, breakpointAfter: 'AGENT_PREFIX' },
      { key: 'customer_context', text: 'Customer: Priya (CIF 1234).', stable: false, breakpointAfter: 'CONVERSATION_CONTEXT' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hi there' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help?' }], breakpointAfter: 'HISTORY' },
      { role: 'user', content: [{ type: 'text', text: 'What is my balance?' }] },
    ],
    tools: TOOLS,
    toolChoice: 'auto',
    temperature: 0.2,
    maxOutputTokens: 512,
    timeoutMs: 10_000,
    cache: { policy: 'PREFIX', key: 'agent-7:pv-3' },
    ...over,
  };
}

export function runtimeConfig(
  kind: ProviderKind,
  settings: Record<string, unknown>,
  credentials: Record<string, string>,
  region: string | null = null,
): ProviderRuntimeConfig {
  return { id: `prov-${kind.toLowerCase()}`, kind, name: `${kind} test`, region, residencyZone: 'IN', settings, credentials };
}

export async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

/** Recursively count object keys with any of the given names (cache directives in request bodies). */
export function countKeys(value: unknown, names: ReadonlySet<string>): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countKeys(v, names), 0);
  if (value === null || typeof value !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (names.has(k)) n++;
    n += countKeys(v, names);
  }
  return n;
}

/** Every request-body key through which any provider expresses a prompt-cache directive. */
export const CACHE_DIRECTIVE_KEYS: ReadonlySet<string> = new Set([
  'cache_control',
  'cachePoint',
  'prompt_cache_key',
  'prompt_cache_retention',
  'prompt_cache_options',
  'prompt_cache_breakpoint',
  'cachedContent',
]);
