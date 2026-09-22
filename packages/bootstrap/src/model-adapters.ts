import { eq } from 'drizzle-orm';
import type { ProviderAdapterSource } from '@ocso/agent-runtime';
import { parseSettings, resolveCredentials, toRuntimeConfig, type ProviderRow } from '@ocso/application';
import { modelProfiles, modelProviders, type Db } from '@ocso/db';
import { notFound, type MediaResolver } from '@ocso/domain';
import { createDefaultRegistry, type ModelCapabilities, type ModelProviderAdapter, type ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';

/** Provider registry for this deployment; DEV_SCRIPTED only when explicitly enabled (ADR-015). */
export function createProviderRegistry(env: { OCSO_ENABLE_DEV_PROVIDERS: boolean }): ProviderRegistry {
  return createDefaultRegistry({ enableDevProviders: env.OCSO_ENABLE_DEV_PROVIDERS });
}

/** Media input support of a profile's primary target (structurally the prompt compiler's ModelInputCapabilities). */
export type ModelInputCapabilities = Pick<ModelCapabilities, 'imageInput' | 'fileInput' | 'audioInput'>;

export interface CachedProviderAdapterSourceOptions {
  db: Db;
  secrets: SecretStore;
  registry: ProviderRegistry;
  /** Resolves blob keys to bytes inside the adapter (blob keys never reach a provider). */
  media: MediaResolver;
  /** Injected for tests (recorded provider responses). */
  fetch?: typeof fetch | undefined;
}

interface CacheEntry {
  /** `updated_at` of the provider row the adapter was built from. */
  version: number;
  adapter: Promise<ModelProviderAdapter>;
}

/**
 * ProviderAdapterSource for the model gateway. One adapter per provider
 * configuration, reused across requests so credential and token caches inside
 * the adapter survive (model-providers README). The row's `updated_at` is the
 * cache key: every configuration or credential change bumps it, so the next
 * `get()` rebuilds the adapter with freshly resolved secrets.
 */
export class CachedProviderAdapterSource implements ProviderAdapterSource {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: CachedProviderAdapterSourceOptions) {}

  async get(providerId: string): Promise<ModelProviderAdapter> {
    const [row] = await this.options.db.select().from(modelProviders).where(eq(modelProviders.id, providerId));
    if (!row) {
      this.cache.delete(providerId);
      throw notFound('model_provider', providerId);
    }
    const version = row.updatedAt.getTime();
    const hit = this.cache.get(providerId);
    if (hit && hit.version === version) return hit.adapter;
    const adapter = this.build(row);
    this.cache.set(providerId, { version, adapter });
    // A failed build (bad config, missing secret) is not cached: the next call retries.
    adapter.catch(() => {
      if (this.cache.get(providerId)?.adapter === adapter) this.cache.delete(providerId);
    });
    return adapter;
  }

  /** Drop cached adapters (all, or one provider). */
  invalidate(providerId?: string): void {
    if (providerId) this.cache.delete(providerId);
    else this.cache.clear();
  }

  /**
   * Media input capabilities of a profile's primary target. Computed from the
   * provider definition and stored settings, so no credentials are resolved.
   */
  async capabilitiesForProfile(profileId: string): Promise<ModelInputCapabilities> {
    const [profile] = await this.options.db
      .select({ providerId: modelProfiles.providerId, model: modelProfiles.model })
      .from(modelProfiles)
      .where(eq(modelProfiles.id, profileId));
    if (!profile) throw notFound('model_profile', profileId);
    const [provider] = await this.options.db
      .select({ kind: modelProviders.kind, settings: modelProviders.settings })
      .from(modelProviders)
      .where(eq(modelProviders.id, profile.providerId));
    if (!provider) throw notFound('model_provider', profile.providerId);
    const definition = this.options.registry.require(provider.kind);
    const caps = definition.capabilities(profile.model, parseSettings(definition, provider.settings));
    return { imageInput: caps.imageInput, fileInput: caps.fileInput, audioInput: caps.audioInput };
  }

  private async build(row: ProviderRow): Promise<ModelProviderAdapter> {
    const credentials = await resolveCredentials(this.options.secrets, row.secretRefs);
    return this.options.registry.create(toRuntimeConfig(row, credentials), {
      media: this.options.media,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
}
