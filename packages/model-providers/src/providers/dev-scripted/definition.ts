import { z } from 'zod';
import type { ModelCapabilities, ModelRequest } from '../../contract/types.js';
import { createAiSdkAdapter } from '../../core/adapter.js';
import type { ProviderOptionsPlan } from '../../core/spec.js';
import { commonSettingsShape, parseProviderConfig, withOverrides, type ProviderDefinition } from '../definition.js';
import { MAX_EXPLICIT_BREAKPOINTS } from '../shared/cache-plans.js';
import { ScriptedLanguageModel } from './model.js';
import { DEV_PROVIDER_OPTIONS_KEY, PrefixCacheSimulator } from './usage.js';

/**
 * DEV_SCRIPTED — development only (ADR-015). Registered only when dev
 * providers are enabled; never use in production. Deterministic keyword-
 * driven replies, tool calls and handoff requests with configurable latency
 * and synthetic usage (including simulated prompt-cache reads/writes).
 */

const settingsSchema = z.object({
  /** Delay before the first token (simulated TTFT). */
  latencyMs: z.number().int().min(0).max(30_000).default(300),
  /** Delay between streamed word chunks. */
  chunkDelayMs: z.number().int().min(0).max(2_000).default(25),
  /** Make every call fail, to demo retries and fallback. */
  simulateError: z.enum(['RATE_LIMITED', 'UNAVAILABLE']).optional(),
  ...commonSettingsShape,
});
const credentialsSchema = z.object({});

export type DevScriptedSettings = z.infer<typeof settingsSchema>;

function devCapabilities(): ModelCapabilities {
  return {
    imageInput: true,
    fileInput: true,
    audioInput: true,
    toolCalling: true,
    structuredOutput: false,
    reasoning: false,
    streaming: true,
    promptCaching: 'EXPLICIT',
    reportsCacheWrites: true,
  };
}

function devProviderOptions(request: ModelRequest): ProviderOptionsPlan {
  if (request.cache.policy === 'OFF') return {};
  return {
    breakpoint: (kind) => ({ [DEV_PROVIDER_OPTIONS_KEY]: { cacheBreakpoint: kind } }),
    maxBreakpoints: MAX_EXPLICIT_BREAKPOINTS,
  };
}

export const devScriptedProvider: ProviderDefinition<DevScriptedSettings, Record<string, never>> = {
  kind: 'DEV_SCRIPTED',
  label: 'Scripted model (development only)',
  devOnly: true,
  settingsSchema,
  credentialsSchema,
  capabilities: (model, settings) => withOverrides(devCapabilities(), model, settings.capabilityOverrides),
  providerOptions: (_model, request) => devProviderOptions(request),
  create(config, deps) {
    const { settings } = parseProviderConfig(devScriptedProvider, config);
    let counter = 0;
    const runtime = {
      cache: new PrefixCacheSimulator(),
      nextId: () => `dev-${config.id}-${String(++counter).padStart(6, '0')}`,
    };
    const modelOptions = {
      latencyMs: settings.latencyMs,
      chunkDelayMs: settings.chunkDelayMs,
      simulateError: settings.simulateError,
    };
    const adapter = createAiSdkAdapter({
      kind: 'DEV_SCRIPTED',
      providerId: config.id,
      region: config.region,
      media: deps.media,
      capabilities: (model) => devScriptedProvider.capabilities(model, settings),
      languageModel: (model) => new ScriptedLanguageModel(model, modelOptions, runtime),
      providerOptions: (model, request) => devScriptedProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['x-request-id'],
      healthModel: settings.healthModel ?? 'scripted-1',
      secrets: [],
    });
    // Any id works; these are the conventional names the demo and tests use.
    const scripted = (id: string) => ({ id, displayName: `Scripted model (${id})`, createdAt: null, ownedBy: 'ocso', kind: 'model' as const, input: ['text', 'image'] as const });
    return { ...adapter, listModels: async () => [...new Set(['scripted-1', 'scripted-2', settings.healthModel ?? 'scripted-1'])].map(scripted) };
  },
};
