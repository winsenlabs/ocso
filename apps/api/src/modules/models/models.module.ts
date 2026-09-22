import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createCatalogFetch, ModelCatalogService, ModelListService, PricingService, ProfileService, ProviderService } from '@ocso/application';
import { CachedProviderAdapterSource } from '@ocso/bootstrap';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { GuardedFetch } from '@ocso/mcp';
import type { ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { DB, ENV, PROVIDER_REGISTRY, SECRET_STORE } from '../../infrastructure/tokens.js';
import { ModelCatalogController } from './model-catalog.controller.js';
import { ModelPricingController } from './model-pricing.controller.js';
import { ModelProfilesController } from './model-profiles.controller.js';
import { ModelProvidersController } from './model-providers.controller.js';

/** The provider registry is built once by the composition root (InfrastructureModule); re-exported for this module's importers. */
export { PROVIDER_REGISTRY };

/** Model catalog downloads: SSRF guard + host allowlist (models.dev, raw.githubusercontent.com). */
@Injectable()
export class CatalogEgress implements OnModuleDestroy {
  readonly guarded: GuardedFetch = createCatalogFetch();

  onModuleDestroy(): void {
    this.guarded.close();
  }
}

/** Model providers, logical model profiles, pricing and the model catalog (docs/06, ADR-006, ADR-012, ADR-027). */
@Module({
  controllers: [ModelProvidersController, ModelProfilesController, ModelPricingController, ModelCatalogController],
  providers: [
    CatalogEgress,
    {
      provide: ModelCatalogService,
      inject: [DB, CatalogEgress, ENV],
      // OCSO_MODEL_CATALOG_REFRESH=false (air-gapped): bundled snapshot only, refresh disabled.
      useFactory: (db: Db, egress: CatalogEgress, env: ApiEnv) =>
        new ModelCatalogService({ db, ...(env.OCSO_MODEL_CATALOG_REFRESH ? { fetch: egress.guarded.fetch } : {}) }),
    },
    {
      provide: ProviderService,
      inject: [DB, SECRET_STORE, PROVIDER_REGISTRY],
      useFactory: (db: Db, secrets: SecretStore, registry: ProviderRegistry) => new ProviderService({ db, secrets, registry }),
    },
    {
      provide: ProfileService,
      inject: [DB, PROVIDER_REGISTRY, ModelCatalogService],
      useFactory: (db: Db, registry: ProviderRegistry, catalog: ModelCatalogService) => new ProfileService({ db, registry, catalog }),
    },
    {
      provide: PricingService,
      inject: [DB, PROVIDER_REGISTRY, ModelCatalogService],
      useFactory: (db: Db, registry: ProviderRegistry, catalog: ModelCatalogService) => new PricingService({ db, registry, catalog }),
    },
    {
      // Listings go through the same cached, credential-resolving adapters as model calls.
      provide: ModelListService,
      inject: [DB, CachedProviderAdapterSource, PROVIDER_REGISTRY, ModelCatalogService],
      useFactory: (db: Db, adapters: CachedProviderAdapterSource, registry: ProviderRegistry, catalog: ModelCatalogService) =>
        new ModelListService({ db, adapters, registry, catalog }),
    },
  ],
  exports: [ProviderService, ProfileService, PricingService, ModelCatalogService, ModelListService],
})
export class ModelsModule {}
