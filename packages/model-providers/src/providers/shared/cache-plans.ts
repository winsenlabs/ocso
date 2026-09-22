import type { JSONObject } from '@ai-sdk/provider';
import type { ModelRequest } from '../../contract/types.js';
import type { ProviderOptions, ProviderOptionsPlan } from '../../core/spec.js';

/**
 * Cache directive builders shared by several provider paths (research/01 §4).
 * Every builder returns NO cache directives when `request.cache.policy` is OFF.
 */

export const MAX_EXPLICIT_BREAKPOINTS = 4;

/**
 * Anthropic Messages (1P, Vertex-Claude, Foundry-Claude): `cacheControl` →
 * `cache_control`. `toolStreaming: false` keeps tool definitions identical
 * between streaming and non-streaming calls (the SDK otherwise adds
 * `eager_input_streaming` to streamed tools, changing the cached prefix);
 * OCSO only surfaces complete tool calls, so nothing is lost.
 */
export function anthropicCachePlan(request: ModelRequest): ProviderOptionsPlan {
  const base: ProviderOptionsPlan = { request: { anthropic: { toolStreaming: false } } };
  if (request.cache.policy === 'OFF') return base;
  const cacheControl: JSONObject = request.cache.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  return {
    ...base,
    breakpoint: () => ({ anthropic: { cacheControl } }),
    maxBreakpoints: MAX_EXPLICIT_BREAKPOINTS,
  };
}

/** Bedrock Converse: `cachePoint` blocks. The 1h TTL applies to Claude 4.5+ only. */
export function bedrockCachePlan(request: ModelRequest, allowLongTtl: boolean): ProviderOptionsPlan {
  if (request.cache.policy === 'OFF') return {};
  const cachePoint: JSONObject =
    request.cache.ttl === '1h' && allowLongTtl ? { type: 'default', ttl: '1h' } : { type: 'default' };
  return {
    breakpoint: () => ({ bedrock: { cachePoint } }),
    maxBreakpoints: MAX_EXPLICIT_BREAKPOINTS,
  };
}

export interface OpenAiFamilyCacheOptions {
  /** Provider-options key the model reads: `openai`, or `azure` for Azure Responses. */
  key: 'openai' | 'azure';
  /** GPT-5.6+ explicit breakpoints (else key + retention only). */
  explicitBreakpoints: boolean;
  /** `store` value to send; undefined leaves the provider default. */
  store: boolean | undefined;
}

/**
 * OpenAI / Azure OpenAI: automatic prefix caching steered by
 * `promptCacheKey`; `promptCacheRetention: '24h'` before GPT-5.6; explicit
 * part-level breakpoints + `promptCacheOptions` on 5.6+.
 */
export function openAiFamilyPlan(request: ModelRequest, opts: OpenAiFamilyCacheOptions): ProviderOptionsPlan {
  const options: JSONObject = {};
  if (opts.store !== undefined) options['store'] = opts.store;
  const wrap = (o: JSONObject): ProviderOptions | undefined => (Object.keys(o).length > 0 ? { [opts.key]: o } : undefined);
  if (request.cache.policy === 'OFF') return { request: wrap(options) };
  if (request.cache.key) options['promptCacheKey'] = request.cache.key;
  if (!opts.explicitBreakpoints) {
    if (request.cache.ttl === '1h') options['promptCacheRetention'] = '24h';
    return { request: wrap(options) };
  }
  options['promptCacheOptions'] = request.cache.ttl === '1h' ? { mode: 'implicit', ttl: '30m' } : { mode: 'implicit' };
  return {
    request: wrap(options),
    breakpoint: () => ({ [opts.key]: { promptCacheBreakpoint: { mode: 'explicit' } } }),
    maxBreakpoints: MAX_EXPLICIT_BREAKPOINTS,
  };
}
