import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider';
import type { CacheBreakpoint, MediaResolver } from '@ocso/domain';
import type { LanguageModelUsage } from 'ai';
import type { ModelCapabilities, ModelRequest, ProviderKind } from '../contract/types.js';
import type { SdkUsageLike } from './usage.js';

/** AI SDK `providerOptions` map (`{ [providerKey]: JSONObject }`). Adapter-internal. */
export type ProviderOptions = SharedV4ProviderOptions;

/**
 * Per-request provider options (research/01 §4). Built by each provider
 * module; the shared core only places them.
 */
export interface ProviderOptionsPlan {
  /** Request-level options: cache keys, retention, `store`, reasoning overrides. */
  request?: ProviderOptions | undefined;
  /**
   * Marker attached where a compiler cache breakpoint sits (system block or
   * last part of a message). Omitted = the provider takes no explicit markers.
   */
  breakpoint?: ((kind: CacheBreakpoint) => ProviderOptions) | undefined;
  /** Provider limit on explicit breakpoints (Anthropic/Bedrock: 4). */
  maxBreakpoints?: number | undefined;
  /** Pass the portable `reasoning` call option. Default true. */
  portableReasoning?: boolean | undefined;
}

export interface HealthProbeOptions {
  maxOutputTokens?: number | undefined;
  reasoning?: ModelRequest['reasoning'];
}

/** Everything the shared AI-SDK core needs from one provider module. */
export interface AiSdkAdapterSpec {
  kind: ProviderKind;
  providerId: string;
  region: string | null;
  media: MediaResolver;
  capabilities(model: string): ModelCapabilities;
  /** Model INSTANCE for this call. Never a string id (strings route to the Vercel AI Gateway). */
  languageModel(model: string, request: ModelRequest): LanguageModelV4;
  providerOptions(model: string, request: ModelRequest): ProviderOptionsPlan;
  /** Response headers carrying the provider request id, in priority order. */
  requestIdHeaders: readonly string[];
  /**
   * Optional usage fix-up, e.g. to turn an SDK-defaulted `0` back into
   * "not reported" by looking at `usage.raw`.
   */
  adjustUsage?: ((usage: LanguageModelUsage, model: string) => SdkUsageLike) | undefined;
  /** Model used by `health()` when the caller does not name one. */
  healthModel: string | null;
  /** Health-probe tuning: smallest accepted output budget, reasoning off where needed. */
  healthProbe?: HealthProbeOptions | undefined;
  /** Credential values that must never appear in errors (defence in depth). */
  secrets: readonly string[];
}
