import type { Provider } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { ProviderAdapterSource } from '@ocso/agent-runtime';
import type { BlobStore } from '@ocso/blob';
import { CachedProviderAdapterSource, McpToolProviderFactory, createProviderRegistry } from '@ocso/bootstrap';
import type { WorkerEnv } from '@ocso/config';
import { modelProfiles, type Db } from '@ocso/db';
import type { ModelInputCapabilities } from '@ocso/prompt-compiler';
import type { SecretStore } from '@ocso/secrets';
import { SettingsService } from '@ocso/application';
import { BLOB_STORE, DB, ENV, PROVIDER_SOURCE, SECRET_STORE, TOOL_PROVIDERS } from '../infrastructure/tokens.js';

/** Model provider adapters and MCP tool providers, resolved from configuration + SecretStore. */
export const ADAPTER_PROVIDERS: Provider[] = [
  {
    provide: PROVIDER_SOURCE,
    inject: [ENV, DB, SECRET_STORE, BLOB_STORE],
    useFactory: (env: WorkerEnv, db: Db, secrets: SecretStore, blobs: BlobStore) =>
      new CachedProviderAdapterSource(db, secrets, createProviderRegistry(env), {
        media: {
          resolve: async (blobKey) => {
            const obj = await blobs.get(blobKey);
            return { data: obj.data, mimeType: obj.contentType };
          },
        },
      }),
  },
  {
    provide: TOOL_PROVIDERS,
    inject: [DB, SECRET_STORE, SettingsService],
    useFactory: (db: Db, secrets: SecretStore, settings: SettingsService) => new McpToolProviderFactory(db, secrets, settings),
  },
];

/** Input modalities of a profile's primary target (drives media inclusion in prompts). */
export function capabilitiesResolver(db: Db, source: ProviderAdapterSource) {
  const cache = new Map<string, { value: ModelInputCapabilities; at: number }>();
  return async (profileId: string): Promise<ModelInputCapabilities> => {
    const hit = cache.get(profileId);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const [profile] = await db.select().from(modelProfiles).where(eq(modelProfiles.id, profileId));
    let value: ModelInputCapabilities = { imageInput: false, fileInput: false, audioInput: false };
    if (profile) {
      try {
        const caps = (await source.get(profile.providerId)).capabilities(profile.model);
        value = { imageInput: caps.imageInput, fileInput: caps.fileInput, audioInput: caps.audioInput };
      } catch {
        // Unconfigured provider: text-only until fixed; the gateway surfaces the real error.
      }
    }
    cache.set(profileId, { value, at: Date.now() });
    return value;
  };
}
