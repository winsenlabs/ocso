import type { Provider } from '@nestjs/common';
import type { ProviderAdapterSource } from '@ocso/agent-runtime';
import { SettingsService } from '@ocso/application';
import type { BlobStore } from '@ocso/blob';
import { CachedProviderAdapterSource, createRuntimeToolRegistry, type OcsoPlugin } from '@ocso/bootstrap';
import type { Db } from '@ocso/db';
import type { ProviderRegistry } from '@ocso/model-providers';
import type { ModelInputCapabilities } from '@ocso/prompt-compiler';
import type { SecretStore } from '@ocso/secrets';
import { BLOB_STORE, DB, PLUGINS, PROVIDER_REGISTRY, PROVIDER_SOURCE, SECRET_STORE, TOOL_PROVIDERS } from '../infrastructure/tokens.js';

/** Model provider adapters and the tool-provider registry, resolved from configuration + SecretStore. */
export const ADAPTER_PROVIDERS: Provider[] = [
  {
    provide: PROVIDER_SOURCE,
    inject: [PROVIDER_REGISTRY, DB, SECRET_STORE, BLOB_STORE],
    useFactory: (registry: ProviderRegistry, db: Db, secrets: SecretStore, blobs: BlobStore) =>
      new CachedProviderAdapterSource({
        db,
        secrets,
        registry,
        media: {
          resolve: async (blobKey: string) => {
            const obj = await blobs.get(blobKey);
            return { data: obj.data, mimeType: obj.contentType };
          },
        },
      }),
  },
  {
    provide: TOOL_PROVIDERS,
    inject: [DB, SECRET_STORE, SettingsService, PLUGINS],
    // One registry from every plugin's tool sources: built-in tools + MCP connections (same authorization and audit path).
    useFactory: (db: Db, secrets: SecretStore, settings: SettingsService, plugins: readonly OcsoPlugin[]) =>
      createRuntimeToolRegistry(db, secrets, settings, plugins),
  },
];

/** Input modalities of a profile's primary target (drives media inclusion in prompts). */
export function capabilitiesResolver(_db: Db, source: ProviderAdapterSource) {
  const cache = new Map<string, { value: ModelInputCapabilities; at: number }>();
  return async (profileId: string): Promise<ModelInputCapabilities> => {
    const hit = cache.get(profileId);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    let value: ModelInputCapabilities = { imageInput: false, fileInput: false, audioInput: false };
    try {
      value = await (source as CachedProviderAdapterSource).capabilitiesForProfile(profileId);
    } catch {
      // Unconfigured provider: text-only until fixed; the gateway surfaces the real error.
    }
    cache.set(profileId, { value, at: Date.now() });
    return value;
  };
}
