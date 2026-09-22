import { Module } from '@nestjs/common';
import { PricingService, ProfileService, ProviderService } from '@ocso/application';
import { createProviderRegistry } from '@ocso/bootstrap';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { ProviderRegistry } from '@ocso/model-providers';
import type { SecretStore } from '@ocso/secrets';
import { DB, ENV, SECRET_STORE } from '../../infrastructure/tokens.js';
import { ModelPricingController } from './model-pricing.controller.js';
import { ModelProfilesController } from './model-profiles.controller.js';
import { ModelProvidersController } from './model-providers.controller.js';

/** Provider registry of this deployment (DEV_SCRIPTED only when OCSO_ENABLE_DEV_PROVIDERS=true). */
export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');

/** Model providers, logical model profiles and pricing (docs/06, ADR-006, ADR-012). */
@Module({
  controllers: [ModelProvidersController, ModelProfilesController, ModelPricingController],
  providers: [
    { provide: PROVIDER_REGISTRY, inject: [ENV], useFactory: (env: ApiEnv): ProviderRegistry => createProviderRegistry(env) },
    {
      provide: ProviderService,
      inject: [DB, SECRET_STORE, PROVIDER_REGISTRY],
      useFactory: (db: Db, secrets: SecretStore, registry: ProviderRegistry) => new ProviderService({ db, secrets, registry }),
    },
    {
      provide: ProfileService,
      inject: [DB, PROVIDER_REGISTRY],
      useFactory: (db: Db, registry: ProviderRegistry) => new ProfileService({ db, registry }),
    },
    { provide: PricingService, inject: [DB], useFactory: (db: Db) => new PricingService(db) },
  ],
  exports: [PROVIDER_REGISTRY, ProviderService, ProfileService, PricingService],
})
export class ModelsModule {}
