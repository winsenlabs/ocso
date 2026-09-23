import type { ZodType } from 'zod';
import type { CacheBreakpoint, MediaResolver, ModelMessage, SystemBlock, ToolSpec } from './domain.js';

/**
 * The model provider contract. A provider plugin contributes a
 * `ProviderDefinition`: its admin form (zod schemas, which OCSO converts to
 * form fields, so `zod` 4 is a peer dependency of provider plugins), its
 * pricing catalog mapping and the factory for an adapter bound to one
 * configured provider.
 */

/** A model provider kind (`OPENAI`, `BEDROCK`…): upper snake case, see `PROVIDER_KIND_PATTERN`. */
export type ProviderKind = string;

export type ModelPurpose = 'TURN' | 'SUMMARY' | 'COPILOT' | 'INTERNAL_AGENT' | 'CLASSIFIER' | 'EVALUATION' | 'TEST';

export type PromptCachingSupport = 'EXPLICIT' | 'AUTOMATIC' | 'UNSUPPORTED' | 'UNVERIFIED';

export interface ModelCapabilities {
  imageInput: boolean;
  fileInput: boolean;
  audioInput: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  streaming: boolean;
  promptCaching: PromptCachingSupport;
  /** Cache writes reported separately from reads. */
  reportsCacheWrites: boolean;
}

export type CachePolicy = 'OFF' | 'PREFIX';

export interface ModelRequest {
  purpose: ModelPurpose;
  system: readonly SystemBlock[];
  messages: readonly ModelMessage[];
  tools: readonly ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number | undefined;
  maxOutputTokens: number;
  reasoning?: 'none' | 'low' | 'medium' | 'high' | undefined;
  timeoutMs: number;
  abortSignal?: AbortSignal | undefined;
  cache: {
    policy: CachePolicy;
    ttl?: '5m' | '1h' | undefined;
    /** Stable key for providers with key-based cache routing. */
    key?: string | undefined;
  };
  /** Request structured JSON output conforming to this JSON Schema. */
  responseSchema?: Record<string, unknown> | undefined;
}

export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other';

/** Normalized usage. `null` means "not reported by the provider", never zero. */
export interface NormalizedUsage {
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  reasoningTokens: number | null;
}

export interface ModelIdentity {
  providerId: string;
  kind: ProviderKind;
  model: string;
  region: string | null;
  requestId: string | null;
}

export interface ModelResult {
  text: string;
  toolCalls: ToolCallRequest[];
  structured?: unknown;
  finishReason: FinishReason;
  usage: NormalizedUsage;
  identity: ModelIdentity;
  latencyMs: number;
  ttftMs: number | null;
  warnings: string[];
}

export type ModelStreamEvent = { type: 'text-delta'; text: string } | { type: 'tool-call'; call: ToolCallRequest } | { type: 'finish'; result: ModelResult };

export interface ProviderHealth {
  status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
  latencyMs: number | null;
  checkedAt: string;
  detail?: string | undefined;
}

/** Resolved provider configuration. Credentials are resolved from the secret store by OCSO. */
export interface ProviderRuntimeConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  region: string | null;
  residencyZone: string | null;
  settings: Readonly<Record<string, unknown>>;
  credentials: Readonly<Record<string, string>>;
}

export interface AdapterDeps {
  media: MediaResolver;
  /** Injected for contract tests (recorded provider responses); absent in production. */
  fetch?: typeof fetch | undefined;
}

export type ModelInputKind = 'text' | 'image' | 'pdf' | 'audio' | 'video';

/** One model a configured provider offers, as its own listing API reports it (never invented). */
export interface ProviderModelInfo {
  id: string;
  displayName: string | null;
  createdAt: string | null;
  ownedBy: string | null;
  kind: 'model' | 'inference-profile' | 'deployment';
  input?: readonly ModelInputKind[] | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  lifecycle?: 'ACTIVE' | 'LEGACY' | 'DEPRECATED' | undefined;
  baseModel?: string | undefined;
}

export interface ListModelsOptions {
  abortSignal?: AbortSignal | undefined;
}

/** One adapter instance is bound to one provider configuration. Errors are thrown as `pluginError(...)`. */
export interface ModelProviderAdapter {
  readonly kind: ProviderKind;
  readonly providerId: string;
  capabilities(model: string): ModelCapabilities;
  /** Streams events; the final event is always `finish`. */
  stream(request: ModelRequest, model: string): AsyncIterable<ModelStreamEvent>;
  generate(request: ModelRequest, model: string): Promise<ModelResult>;
  health(model?: string): Promise<ProviderHealth>;
  /** Models this configuration can call, from the provider's own listing (optional). */
  listModels?(options?: ListModelsOptions): Promise<ProviderModelInfo[]>;
}

/** JSON values as the AI SDK's `providerOptions` carry them. */
export type JSONValue = null | string | number | boolean | Readonly<JSONObject> | readonly JSONValue[];
export type JSONObject = { [key: string]: JSONValue | undefined };

/** `providerOptions` map (`{ [providerKey]: JSONObject }`), the Vercel AI SDK's `SharedV4ProviderOptions`. */
export type ProviderOptions = Record<string, JSONObject>;

/** Per-request provider options, built by the provider module; OCSO's shared core only places them. */
export interface ProviderOptionsPlan {
  /** Request-level options: cache keys, retention, reasoning overrides. */
  request?: ProviderOptions | undefined;
  /** Marker attached where a cache breakpoint sits. Omitted = the provider takes no explicit markers. */
  breakpoint?: ((kind: CacheBreakpoint) => ProviderOptions) | undefined;
  /** Provider limit on explicit breakpoints. */
  maxBreakpoints?: number | undefined;
  /** Pass the portable `reasoning` call option. Default true. */
  portableReasoning?: boolean | undefined;
}

export type PromptCachingMode = 'explicit' | 'key-based' | 'implicit' | 'unverified' | 'none';

/** Prompt caching of one model in words, for the admin UI. */
export interface PromptCachingDescription {
  mode: PromptCachingMode;
  mechanism: string;
  effect: { '5m': string; '1h': string };
}

export type CatalogSource = 'models.dev' | 'litellm';

export interface CatalogCandidate {
  source: CatalogSource;
  /** models.dev provider id, or LiteLLM `litellm_provider`. */
  provider: string;
  id: string;
}

/** A provider's mapping from its model ids to open-source catalog keys (for pricing). */
export interface ProviderCatalogMapping {
  readonly providers: Readonly<Partial<Record<CatalogSource, readonly string[]>>>;
  readonly listingProvider?: string | undefined;
  /** Catalog keys for one model id, in preference order; [] = not priced. */
  candidates(model: string, baseModel: string | null): CatalogCandidate[];
}

/** One registrable model provider module. */
export interface ProviderDefinition<S = unknown, C = unknown> {
  /** Upper snake case (`PROVIDER_KIND_PATTERN`); stored on provider rows and usage. */
  readonly kind: ProviderKind;
  readonly label: string;
  /** Short mono mark shown in place of a vendor logo (1–4 characters). */
  readonly mark: string;
  /** One line on what the adapter does for prompt caching. */
  readonly cachingSummary: string;
  /** Development-only providers are registered only when the operator enables them. */
  readonly devOnly: boolean;
  /** Non-secret settings the admin enters. */
  readonly settingsSchema: ZodType<S>;
  /** Secret fields, resolved from the secret store by OCSO. */
  readonly credentialsSchema: ZodType<C>;
  readonly catalog?: ProviderCatalogMapping | undefined;
  capabilities(model: string, settings: S): ModelCapabilities;
  providerOptions(model: string, request: ModelRequest, settings: S): ProviderOptionsPlan;
  describeCaching?(model: string, settings: S): PromptCachingDescription;
  baseModel?(model: string, settings: S): string | null;
  create(config: ProviderRuntimeConfig, deps: AdapterDeps): ModelProviderAdapter;
}
