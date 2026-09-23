import { isDomainError, validation, type MediaResolver } from '@ocso/domain';
import type { modelProviders } from '@ocso/db';
import type { AdapterDeps, ProviderDefinition, ProviderRegistry, ProviderRuntimeConfig } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { declaredFieldNames } from './field-descriptors.js';

export type ProviderRow = typeof modelProviders.$inferSelect;
type ConfigSource = Pick<ProviderRow, 'id' | 'kind' | 'name' | 'region' | 'residencyZone' | 'settings'>;

/** Media resolver for admin-side calls (test connection): they never carry media. */
export const NO_MEDIA: MediaResolver = {
  resolve: () => Promise.reject(validation('media_not_available', 'Media is not available for this call')),
};

/** Resolve a provider's credential values. Trusted server-side code only (ADR-012). */
export async function resolveCredentials(secrets: SecretStore, secretRefs: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.entries(secretRefs).map(async ([key, ref]) => [key, await secrets.resolve(ref)] as const));
  return Object.fromEntries(entries);
}

export function toRuntimeConfig(row: ConfigSource, credentials: Readonly<Record<string, string>>): ProviderRuntimeConfig {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    region: row.region,
    residencyZone: row.residencyZone,
    settings: row.settings,
    credentials,
  };
}

/** Validate settings only (no credentials needed): used for capabilities and policy checks. */
export function parseSettings(definition: ProviderDefinition, settings: unknown): Record<string, unknown> {
  const parsed = definition.settingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw validation('provider_settings_invalid', `Settings for ${definition.label} are invalid`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    });
  }
  return parsed.data as Record<string, unknown>;
}

/**
 * Save-time validation of a complete provider configuration: settings and
 * credentials against the definition's schemas, unknown credential names, then
 * the adapter factory itself (cross-field rules such as "Bedrock needs a
 * region"). Error details name fields only, never values. Returns the parsed
 * (effective) settings to store.
 */
export function validateProviderConfig(
  registry: ProviderRegistry,
  source: ConfigSource,
  credentials: Readonly<Record<string, string>>,
  deps: AdapterDeps,
): Record<string, unknown> {
  const definition = registry.require(source.kind);
  const settings = parseSettings(definition, source.settings);
  const known = new Set(declaredFieldNames(definition.credentialsSchema));
  const unknown = Object.keys(credentials).filter((k) => !known.has(k));
  if (unknown.length) {
    throw validation('provider_credentials_invalid', `Unknown credential fields for ${definition.label}`, { fields: unknown });
  }
  const parsed = definition.credentialsSchema.safeParse(credentials);
  if (!parsed.success) {
    throw validation('provider_credentials_invalid', `Credentials for ${definition.label} are missing or invalid`, {
      fields: parsed.error.issues.map((i) => i.path.map(String).join('.')),
    });
  }
  try {
    // Constructing an adapter performs no network I/O; it runs the provider's own config checks.
    definition.create(toRuntimeConfig({ ...source, settings }, credentials), deps);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw validation('provider_configuration_invalid', `The ${definition.label} configuration is invalid`);
  }
  return settings;
}
