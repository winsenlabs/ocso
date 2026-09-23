import { Global, Module } from '@nestjs/common';
import { SettingsService } from '@ocso/application';
import { ModelGateway, UsageRecorder } from '@ocso/agent-runtime';
import type { BlobStore } from '@ocso/blob';
import { CachedProviderAdapterSource } from '@ocso/bootstrap';
import type { Db } from '@ocso/db';
import type { ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { BLOB_STORE, DB, PROVIDER_REGISTRY, SECRET_STORE } from '../../infrastructure/tokens.js';

/**
 * Model execution inside the API process, for interactive features that must
 * stream to a browser (internal agent, copilot rewrite). Same gateway, same
 * policy-bound fallback and usage accounting as the worker.
 */
@Global()
@Module({
  providers: [
    {
      provide: CachedProviderAdapterSource,
      // The one provider registry of this process (composition root), shared with ModelsModule.
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
      provide: ModelGateway,
      inject: [DB, CachedProviderAdapterSource, SettingsService],
      useFactory: (db: Db, source: CachedProviderAdapterSource, settings: SettingsService) => new ModelGateway(db, source, new UsageRecorder(db), settings),
    },
  ],
  exports: [ModelGateway, CachedProviderAdapterSource],
})
export class ModelRuntimeModule {}
