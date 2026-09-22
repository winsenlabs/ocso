import type { DomainError, MediaResolver, ModelMessage, SystemBlock, ToolSpec } from '@ocso/domain';

/** Provider kinds OCSO ships adapters for (docs/06 §1) plus the dev-only scripted provider (ADR-015). */
export const PROVIDER_KINDS = ['BEDROCK', 'VERTEX', 'FOUNDRY', 'OPENAI', 'ANTHROPIC', 'SARVAM', 'DEV_SCRIPTED'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

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
    /** Stable key for providers with key-based routing (OpenAI/Azure `promptCacheKey`). */
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

/** Normalized usage (docs/05 §3). `null` means "not reported by the provider", never zero. */
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

export type ModelStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'finish'; result: ModelResult };

export interface ProviderHealth {
  status: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
  latencyMs: number | null;
  checkedAt: string;
  detail?: string | undefined;
}

/** Resolved provider configuration. Credentials are resolved from SecretStore by trusted code only. */
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
  /** Injected for contract tests (recorded provider responses). */
  fetch?: typeof fetch | undefined;
}

/** Input kinds a listed model accepts, only when the provider's own listing documents them. */
export type ModelInputKind = 'text' | 'image' | 'pdf' | 'audio' | 'video';

/**
 * One model (or deployment / inference profile) a configured provider
 * offers, as its own listing API reports it. `null`/absent = not reported;
 * OCSO never invents these fields (prices and other metadata come from the
 * model catalog, not from here).
 */
export interface ProviderModelInfo {
  /** The id to put in a model profile (model id, inference profile id/ARN, deployment name). */
  id: string;
  displayName: string | null;
  /** ISO timestamp, when the provider reports one. */
  createdAt: string | null;
  ownedBy: string | null;
  /** What the id refers to at this provider. */
  kind: 'model' | 'inference-profile' | 'deployment';
  input?: readonly ModelInputKind[] | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** Provider lifecycle, when reported (e.g. Bedrock LEGACY, Vertex DEPRECATED). */
  lifecycle?: 'ACTIVE' | 'LEGACY' | 'DEPRECATED' | undefined;
  /** Underlying model name for deployments/profiles, when known (catalog lookups use it). */
  baseModel?: string | undefined;
}

export interface ListModelsOptions {
  abortSignal?: AbortSignal | undefined;
}

/** docs/06 §3 — one adapter instance is bound to one provider configuration. */
export interface ModelProviderAdapter {
  readonly kind: ProviderKind;
  readonly providerId: string;
  capabilities(model: string): ModelCapabilities;
  /** Streams events; the final event is always `finish`. Throws DomainError (normalized). */
  stream(request: ModelRequest, model: string): AsyncIterable<ModelStreamEvent>;
  generate(request: ModelRequest, model: string): Promise<ModelResult>;
  health(model?: string): Promise<ProviderHealth>;
  /**
   * Models this configuration can call, from the provider's own listing API
   * (or its configured deployments). Optional: absent = the provider has no
   * listing. Throws DomainError (normalized, never carrying credentials);
   * `model_listing_unsupported` means "no listing endpoint here".
   */
  listModels?(options?: ListModelsOptions): Promise<ProviderModelInfo[]>;
}

export type ModelError = DomainError;
