export * from './contract/types.js';
export * from './policy/fallback-policy.js';
export * from './core/usage.js';

// Shared AI-SDK core (for adapters and tests; runtime code should use the registry).
export { createAiSdkAdapter } from './core/adapter.js';
export type { AiSdkAdapterSpec, HealthProbeOptions, ProviderOptions, ProviderOptionsPlan } from './core/spec.js';
export { normalizeProviderError, scrubSecrets, type ErrorContext } from './core/errors.js';
export { healthProbeRequest } from './core/health.js';

// Provider modules.
export {
  commonSettingsShape,
  parseProviderConfig,
  withOverrides,
  type CapabilityOverrides,
  type ProviderDefinition,
} from './providers/definition.js';
export { anthropicProvider, type AnthropicSettings } from './providers/anthropic/definition.js';
export { bedrockProvider, type BedrockSettings } from './providers/bedrock/definition.js';
export { vertexProvider, type VertexSettings } from './providers/vertex/definition.js';
export { foundryProvider } from './providers/foundry/definition.js';
export type { FoundrySettings } from './providers/foundry/settings.js';
export { openAiProvider, type OpenAiSettings } from './providers/openai/definition.js';
export { sarvamProvider, type SarvamSettings } from './providers/sarvam/definition.js';
export { devScriptedProvider, type DevScriptedSettings } from './providers/dev-scripted/definition.js';

export { ProviderRegistry, createDefaultRegistry, PRODUCTION_PROVIDERS, type DefaultRegistryOptions } from './registry.js';

// Model discovery (listings) and the open-source model catalog + pricing helpers (ADR-027).
export { LISTING_UNSUPPORTED, MODEL_LIST_TIMEOUT_MS } from './discovery/http.js';
export { isOpenAiChatModel, OPENAI_NON_CHAT } from './discovery/openai.js';
export * from './catalog/index.js';
export * from './pricing/price.js';
