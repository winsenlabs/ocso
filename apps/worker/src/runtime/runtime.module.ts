import { Module } from '@nestjs/common';
import { CustomerClaimsIssuer, SettingsService } from '@ocso/application';
import {
  ChannelRuntime,
  ContextBuilder,
  ConversationInsightsService,
  CopilotService,
  EvaluationService,
  DeliveryService,
  HotContextCache,
  LeaseManager,
  MediaMaterializer,
  ModelGateway,
  SummaryService,
  ToolRunner,
  TurnProcessor,
  UsageRecorder,
  type ProviderAdapterSource,
  type ToolProviderFactory,
} from '@ocso/agent-runtime';
import type { BlobStore } from '@ocso/blob';
import type { ChannelRegistry } from '@ocso/channels';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { createAjvValidator } from '@ocso/tools';
import { BLOB_STORE, CHANNEL_REGISTRY, DB, ENV, LOGGER, PROVIDER_SOURCE, QUEUE, SECRET_STORE, TOOL_PROVIDERS, WORKER_ID } from '../infrastructure/tokens.js';
import { ADAPTER_PROVIDERS, capabilitiesResolver } from './adapters.providers.js';
import { WorkerRegistryService } from './worker-registry.service.js';

/** Default lease timing until the first heartbeat loads worker_settings. */
const DEFAULT_TIMING = { leaseSeconds: 45, idleSeconds: 300 };
export const HISTORY_WINDOW = 20;

/**
 * The agent runtime object graph (framework-free classes from
 * @ocso/agent-runtime) bound into Nest DI for the worker process.
 */
@Module({
  providers: [
    ...ADAPTER_PROVIDERS,
    WorkerRegistryService,
    { provide: HotContextCache, useFactory: () => new HotContextCache(2_000) },
    { provide: LeaseManager, inject: [DB, WORKER_ID], useFactory: (db: Db, workerId: string) => new LeaseManager(db, workerId, DEFAULT_TIMING) },
    { provide: UsageRecorder, inject: [DB], useFactory: (db: Db) => new UsageRecorder(db) },
    {
      provide: ModelGateway,
      inject: [DB, PROVIDER_SOURCE, UsageRecorder, SettingsService],
      useFactory: (db: Db, source: ProviderAdapterSource, usage: UsageRecorder, settings: SettingsService) => new ModelGateway(db, source, usage, settings),
    },
    {
      provide: ChannelRuntime,
      inject: [DB, CHANNEL_REGISTRY, SECRET_STORE],
      useFactory: (db: Db, registry: ChannelRegistry, secrets: SecretStore) => new ChannelRuntime(db, registry, secrets),
    },
    { provide: MediaMaterializer, inject: [DB, ChannelRuntime, BLOB_STORE], useFactory: (db: Db, c: ChannelRuntime, b: BlobStore) => new MediaMaterializer(db, c, b) },
    { provide: DeliveryService, inject: [DB, ChannelRuntime, BLOB_STORE], useFactory: (db: Db, c: ChannelRuntime, b: BlobStore) => new DeliveryService(db, c, b) },
    {
      provide: SummaryService,
      inject: [DB, ModelGateway],
      useFactory: (db: Db, gateway: ModelGateway) => new SummaryService(db, gateway, { historyWindow: HISTORY_WINDOW, minNewMessages: 10 }),
    },
    {
      provide: ContextBuilder,
      inject: [DB, HotContextCache, SettingsService],
      useFactory: async (db: Db, hot: HotContextCache, settings: SettingsService) =>
        new ContextBuilder(db, hot, { historyWindow: HISTORY_WINDOW, mediaWindow: 6, timezone: (await settings.deployment()).timezone }),
    },
    { provide: ConversationInsightsService, inject: [DB, ModelGateway], useFactory: (db: Db, gateway: ModelGateway) => new ConversationInsightsService(db, gateway) },
    { provide: EvaluationService, inject: [DB, ModelGateway], useFactory: (db: Db, gateway: ModelGateway) => new EvaluationService(db, gateway, { historyWindow: HISTORY_WINDOW }) },
    {
      provide: CustomerClaimsIssuer,
      inject: [DB, SECRET_STORE, ENV],
      useFactory: (db: Db, secrets: SecretStore, env: WorkerEnv) => new CustomerClaimsIssuer({ db, secrets, issuer: env.OCSO_PUBLIC_URL }),
    },
    {
      provide: CopilotService,
      inject: [DB, ModelGateway, ContextBuilder, PROVIDER_SOURCE],
      useFactory: (db: Db, gateway: ModelGateway, context: ContextBuilder, source: ProviderAdapterSource) =>
        new CopilotService({ db, gateway, context, capabilitiesFor: capabilitiesResolver(db, source) }),
    },
    {
      provide: TurnProcessor,
      inject: [DB, QUEUE, LeaseManager, ModelGateway, ContextBuilder, MediaMaterializer, TOOL_PROVIDERS, PROVIDER_SOURCE, CustomerClaimsIssuer, LOGGER],
      useFactory: (
        db: Db,
        queue: QueueAdapter,
        leases: LeaseManager,
        gateway: ModelGateway,
        context: ContextBuilder,
        media: MediaMaterializer,
        toolProviders: ToolProviderFactory,
        source: ProviderAdapterSource,
        claims: CustomerClaimsIssuer,
        logger: Logger,
      ) => {
        const validate = createAjvValidator();
        return new TurnProcessor({
          db,
          queue,
          leases,
          gateway,
          context,
          media,
          toolRunner: (catalog) => new ToolRunner(db, catalog, toolProviders, validate, claims),
          capabilitiesFor: capabilitiesResolver(db, source),
          logger,
          summarizeAfter: HISTORY_WINDOW * 2,
        });
      },
    },
  ],
  exports: [WorkerRegistryService, CopilotService, CustomerClaimsIssuer, ConversationInsightsService, EvaluationService, HotContextCache, LeaseManager, ModelGateway, TurnProcessor, DeliveryService, MediaMaterializer, SummaryService, PROVIDER_SOURCE, TOOL_PROVIDERS],
})
export class RuntimeModule {}
