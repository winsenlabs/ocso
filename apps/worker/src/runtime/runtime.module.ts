import { Module } from '@nestjs/common';
import { CustomerClaimsIssuer, RoutingEngine, SettingsService } from '@ocso/application';
import {
  ChannelRuntime,
  HeldUserTokenSource,
  channelContextFrom,
  ContextBuilder,
  ConversationInsightsService,
  CopilotService,
  EvaluationService,
  DeliveryService,
  HotContextCache,
  LeaseManager,
  MediaMaterializer,
  ModelGateway,
  RouteProcessor,
  SummaryService,
  createRouterClassifier,
  sessionWindowHoursFrom,
  ToolRunner,
  TurnProcessor,
  UsageRecorder,
  type ProviderAdapterSource,
} from '@ocso/agent-runtime';
import type { BlobStore } from '@ocso/blob';
import type { ChannelRegistry } from '@ocso/channels';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import type { SecretStore } from '@ocso/secrets';
import { createAjvValidator, type ToolProviderRegistry } from '@ocso/tools';
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
      inject: [DB, CHANNEL_REGISTRY, SECRET_STORE, ENV],
      // publicUrl gives webhook channels their callback URL (Twilio per-message status callbacks).
      useFactory: (db: Db, registry: ChannelRegistry, secrets: SecretStore, env: WorkerEnv) =>
        new ChannelRuntime(db, registry, secrets, { publicUrl: env.OCSO_PUBLIC_URL }),
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
      inject: [DB, HotContextCache, SettingsService, CHANNEL_REGISTRY],
      useFactory: async (db: Db, hot: HotContextCache, settings: SettingsService, channels: ChannelRegistry) =>
        new ContextBuilder(db, hot, { historyWindow: HISTORY_WINDOW, mediaWindow: 6, timezone: (await settings.deployment()).timezone, channelContext: channelContextFrom(channels) }),
    },
    { provide: ConversationInsightsService, inject: [DB, ModelGateway], useFactory: (db: Db, gateway: ModelGateway) => new ConversationInsightsService(db, gateway) },
    {
      provide: EvaluationService,
      inject: [DB, ModelGateway, CHANNEL_REGISTRY],
      useFactory: (db: Db, gateway: ModelGateway, channels: ChannelRegistry) => new EvaluationService(db, gateway, { historyWindow: HISTORY_WINDOW, channelContext: channelContextFrom(channels) }),
    },
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
      // Routers (PM/research/11 §5.3): CLASSIFY through the same gateway; router messages honour the channel's session window.
      provide: RoutingEngine,
      inject: [DB, QUEUE, ModelGateway, CHANNEL_REGISTRY, LOGGER],
      useFactory: (db: Db, queue: QueueAdapter, gateway: ModelGateway, channels: ChannelRegistry, logger: Logger) =>
        new RoutingEngine({ db, queue, classifier: createRouterClassifier(gateway), windowHours: sessionWindowHoursFrom(channels), onError: (err, context) => logger.error({ err, ...context }, 'routing problem') }),
    },
    { provide: RouteProcessor, inject: [DB, RoutingEngine, LOGGER], useFactory: (db: Db, engine: RoutingEngine, logger: Logger) => new RouteProcessor({ db, engine, logger }) },
    {
      provide: TurnProcessor,
      inject: [DB, QUEUE, LeaseManager, ModelGateway, ContextBuilder, MediaMaterializer, TOOL_PROVIDERS, PROVIDER_SOURCE, CustomerClaimsIssuer, ChannelRuntime, LOGGER],
      useFactory: (
        db: Db,
        queue: QueueAdapter,
        leases: LeaseManager,
        gateway: ModelGateway,
        context: ContextBuilder,
        media: MediaMaterializer,
        toolProviders: ToolProviderRegistry,
        source: ProviderAdapterSource,
        claims: CustomerClaimsIssuer,
        channels: ChannelRuntime,
        logger: Logger,
      ) => {
        const validate = createAjvValidator();
        const userTokens = new HeldUserTokenSource(db, channels);
        return new TurnProcessor({
          db,
          queue,
          leases,
          gateway,
          context,
          media,
          toolRunner: (catalog) => new ToolRunner(db, catalog, toolProviders, validate, claims, undefined, userTokens),
          capabilitiesFor: capabilitiesResolver(db, source),
          logger,
          summarizeAfter: HISTORY_WINDOW * 2,
        });
      },
    },
  ],
  exports: [RoutingEngine, RouteProcessor, WorkerRegistryService, ChannelRuntime, CopilotService, CustomerClaimsIssuer, ConversationInsightsService, EvaluationService, HotContextCache, LeaseManager, ModelGateway, TurnProcessor, DeliveryService, MediaMaterializer, SummaryService, PROVIDER_SOURCE, TOOL_PROVIDERS],
})
export class RuntimeModule {}
