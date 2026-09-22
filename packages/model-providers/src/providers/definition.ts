import { validation } from '@ocso/domain';
import { z } from 'zod';
import type {
  AdapterDeps,
  ModelCapabilities,
  ModelProviderAdapter,
  ModelRequest,
  ProviderKind,
  ProviderRuntimeConfig,
} from '../contract/types.js';
import type { ProviderOptionsPlan } from '../core/spec.js';

/**
 * One registrable provider module (ADR-006). The registry holds these; no
 * central switch ever names a provider.
 */
export interface ProviderDefinition<S = unknown, C = unknown> {
  readonly kind: ProviderKind;
  readonly label: string;
  /** Dev-only providers are registered only when explicitly enabled (ADR-015). */
  readonly devOnly: boolean;
  /** Non-secret settings the Tech Admin enters (validated at save time and on create). */
  readonly settingsSchema: z.ZodType<S>;
  /** Secret fields, resolved from SecretStore by trusted code only. */
  readonly credentialsSchema: z.ZodType<C>;
  capabilities(model: string, settings: S): ModelCapabilities;
  /** Cache directives, cache keys and reasoning overrides for one request. */
  providerOptions(model: string, request: ModelRequest, settings: S): ProviderOptionsPlan;
  create(config: ProviderRuntimeConfig, deps: AdapterDeps): ModelProviderAdapter;
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

/** All credential values of a config, for error scrubbing. */
export const secretValues = (config: ProviderRuntimeConfig): string[] => Object.values(config.credentials);

export const requiredSecret = (label: string) => z.string().min(1, `${label} is required`);
