import { validation } from '@ocso/domain';
import { z } from 'zod';
import type { CatalogCandidate } from '../catalog/mapping.js';
import type { CatalogSource } from '../catalog/types.js';
import type {
  AdapterDeps,
  ModelCapabilities,
  ModelProviderAdapter,
  ModelRequest,
  ProviderKind,
  ProviderRuntimeConfig,
} from '../contract/types.js';
import type { ProviderOptionsPlan } from '../core/spec.js';
import { describePromptCaching, type PromptCachingDescription } from './shared/caching-description.js';

/**
 * One registrable provider module (ADR-006). The registry holds these; no
 * central switch ever names a provider. Everything OCSO needs to know about a
 * kind lives here: the admin UI (label, mark, caching wording, forms from the
 * schemas), pricing (catalog mapping) and the adapter factory.
 */
export interface ProviderDefinition<S = unknown, C = unknown> {
  /** UPPER_SNAKE_CASE (`PROVIDER_KIND_PATTERN`); stored on provider rows and usage. */
  readonly kind: ProviderKind;
  readonly label: string;
  /** Short mono mark the admin UI shows in place of a vendor logo, e.g. `OAI` (1–4 characters). */
  readonly mark: string;
  /** One line on what the adapter does for prompt caching, shown on provider cards. */
  readonly cachingSummary: string;
  /**
   * Development-only providers (ADR-015): registered only when explicitly
   * enabled, and their usage is never priced (it costs nothing).
   */
  readonly devOnly: boolean;
  /** Non-secret settings the Tech Admin enters (validated at save time and on create). */
  readonly settingsSchema: z.ZodType<S>;
  /** Secret fields, resolved from SecretStore by trusted code only. */
  readonly credentialsSchema: z.ZodType<C>;
  /** Where the open-source model catalogs list this provider's models (ADR-027). Absent: manual prices only. */
  readonly catalog?: ProviderCatalogMapping | undefined;
  capabilities(model: string, settings: S): ModelCapabilities;
  /** Cache directives, cache keys and reasoning overrides for one request. */
  providerOptions(model: string, request: ModelRequest, settings: S): ProviderOptionsPlan;
  /**
   * How one model caches prompts, in words for the admin UI. Absent: derived
   * from `capabilities(model).promptCaching` (see `describePromptCaching`).
   */
  describeCaching?(model: string, settings: S): PromptCachingDescription;
  /**
   * The underlying model of a model id when the id alone does not say which
   * (a deployment name), for catalog lookups. Absent or null: the id itself.
   */
  baseModel?(model: string, settings: S): string | null;
  create(config: ProviderRuntimeConfig, deps: AdapterDeps): ModelProviderAdapter;
}

/**
 * A provider's own mapping from its model ids to catalog keys (research/09
 * §6). Keys must match exactly: no family guessing; when an id says nothing
 * about the model, `candidates` returns [] and the model is not priced.
 */
export interface ProviderCatalogMapping {
  /** The catalog providers `candidates` uses. Snapshots keep only these providers' models. */
  readonly providers: Readonly<Partial<Record<CatalogSource, readonly string[]>>>;
  /** The models.dev provider whose models stand in when this provider has no listing endpoint. */
  readonly listingProvider?: string | undefined;
  /** Catalog keys for one (trimmed, non-empty) model id, in preference order; models.dev before LiteLLM. */
  candidates(model: string, baseModel: string | null): CatalogCandidate[];
}

const capabilityOverride = z
  .object({
    imageInput: z.boolean(),
    fileInput: z.boolean(),
    audioInput: z.boolean(),
    toolCalling: z.boolean(),
    structuredOutput: z.boolean(),
    reasoning: z.boolean(),
    streaming: z.boolean(),
    promptCaching: z.enum(['EXPLICIT', 'AUTOMATIC', 'UNSUPPORTED', 'UNVERIFIED']),
    reportsCacheWrites: z.boolean(),
  })
  .partial();

/** Settings every provider accepts. */
export const commonSettingsShape = {
  /** Model/deployment used by `health()` when none is given. */
  healthModel: z.string().min(1).optional(),
  /** Per-model capability corrections (e.g. a Bedrock model the heuristics misjudge). */
  capabilityOverrides: z.record(z.string(), capabilityOverride).optional(),
};

export type CapabilityOverrides = Readonly<Record<string, z.infer<typeof capabilityOverride>>> | undefined;

export function withOverrides(base: ModelCapabilities, model: string, overrides: CapabilityOverrides): ModelCapabilities {
  const o = overrides?.[model];
  if (!o) return base;
  // Drop explicit `undefined`s so they cannot erase a base capability.
  const defined = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<ModelCapabilities>;
  return { ...base, ...defined };
}

/**
 * Validate settings/credentials. Error details carry only field paths and
 * issue codes, never the values (they may be secrets).
 */
export function parseProviderConfig<S, C>(
  def: Pick<ProviderDefinition<S, C>, 'kind' | 'settingsSchema' | 'credentialsSchema'>,
  config: ProviderRuntimeConfig,
): { settings: S; credentials: C } {
  if (config.kind !== def.kind) {
    throw validation('provider_kind_mismatch', `Configuration kind ${config.kind} does not match ${def.kind}`);
  }
  const settings = def.settingsSchema.safeParse(config.settings);
  if (!settings.success) {
    throw validation('provider_settings_invalid', `Settings for provider ${config.name} are invalid`, {
      issues: settings.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
  }
  const credentials = def.credentialsSchema.safeParse(config.credentials);
  if (!credentials.success) {
    throw validation('provider_credentials_invalid', `Credentials for provider ${config.name} are missing or invalid`, {
      fields: credentials.error.issues.map((i) => i.path.join('.')),
    });
  }
  return { settings: settings.data, credentials: credentials.data };
}

/** How one model caches prompts: the definition's own wording, else the generic one from its capabilities. */
export function promptCachingOf<S>(definition: ProviderDefinition<S>, model: string, settings: S): PromptCachingDescription {
  return definition.describeCaching ? definition.describeCaching(model, settings) : describePromptCaching(definition.capabilities(model, settings));
}

/** All credential values of a config, for error scrubbing. */
export const secretValues = (config: ProviderRuntimeConfig): string[] => Object.values(config.credentials);

export const requiredSecret = (label: string) => z.string().min(1, `${label} is required`);
