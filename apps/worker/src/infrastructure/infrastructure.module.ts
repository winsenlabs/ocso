import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SettingsService, type AuditStore } from '@ocso/application';
import {
  PgListener,
  assertWorkerDrivers,
  createAuditStore,
  createBlobStore,
  createChannelRegistry,
  createDriverRegistries,
  createProviderRegistry,
  createQueue,
  createSecretStore,
  loadAuditSigner,
  loadPlugins,
  pgQueueNotifier,
  pluginSummary,
  type DriverRegistries,
  type OcsoPlugin,
} from '@ocso/bootstrap';
import { WorkerEnv, assertDriverConfig, loadEnv } from '@ocso/config';
import { createDatabase, type Database, type Db } from '@ocso/db';
import { emailStatus, resolveEmailConfig, senderFor, type ResolvedEmailConfig } from '@ocso/email';
import { createLogger, type Logger } from '@ocso/observability';
import { shutdownOtel } from '@ocso/observability/otel';
import { EVENTS_CHANNEL } from '@ocso/application';
import { JOBS_CHANNEL } from '@ocso/bootstrap';
import {
  AUDIT_SIGNER,
  AUDIT_STORE,
  BLOB_STORE,
  CHANNEL_REGISTRY,
  DATABASE,
  DB,
  DRIVERS,
  EMAIL_CONFIG,
  EMAIL_SENDER,
  EMAIL_STATUS,
  ENV,
  LISTENER,
  LOGGER,
  PLUGINS,
  PROVIDER_REGISTRY,
  QUEUE,
  SECRET_STORE,
  WORKER_ID,
} from './tokens.js';

function loadWorkerEnv(drivers: DriverRegistries): WorkerEnv {
  const env = loadEnv(WorkerEnv);
  assertDriverConfig(env);
  assertWorkerDrivers(env, drivers);
  return env;
}

/**
 * Worker infrastructure: the same composition root as the API (@ocso/bootstrap
 * — registries built from PLUGINS, drivers selected by configuration; build rule §17).
 */
@Global()
@Module({
  providers: [
    // FIRST_PARTY_PLUGINS plus the installed plugins OCSO_PLUGINS pins (raw environment; loadEnv strips unknown keys).
    { provide: PLUGINS, useFactory: () => loadPlugins() },
    { provide: DRIVERS, inject: [PLUGINS], useFactory: (plugins: readonly OcsoPlugin[]) => createDriverRegistries(plugins) },
    { provide: ENV, inject: [DRIVERS], useFactory: loadWorkerEnv },
    { provide: WORKER_ID, inject: [ENV], useFactory: (env: WorkerEnv) => env.WORKER_ID ?? `wkr-${randomBytes(3).toString('hex').slice(0, 5)}` },
    {
      provide: LOGGER,
      inject: [ENV, WORKER_ID, PLUGINS],
      useFactory: (env: WorkerEnv, workerId: string, plugins: readonly OcsoPlugin[]) => {
        const logger = createLogger({ service: 'ocso-worker', version: env.APP_VERSION, level: env.LOG_LEVEL }).child({ workerId });
        // The same line the api logs: the two processes must run the same plugins.
        logger.info(pluginSummary(plugins, env.APP_VERSION));
        return logger;
      },
    },
    {
      provide: DATABASE,
      inject: [ENV, LOGGER],
      useFactory: (env: WorkerEnv, logger: Logger): Database =>
        createDatabase({
          connectionString: env.DATABASE_URL,
          maxConnections: env.DATABASE_POOL_SIZE,
          applicationName: 'ocso-worker',
          ssl: env.DATABASE_SSL,
          onError: (err) => logger.warn({ err }, 'idle database connection lost; the pool reconnects'),
        }),
    },
    { provide: DB, inject: [DATABASE], useFactory: (d: Database) => d.db },
    {
      provide: LISTENER,
      inject: [ENV, LOGGER],
      useFactory: async (env: WorkerEnv, logger: Logger) => {
        const listener = new PgListener(env.DATABASE_URL, (err) => logger.warn({ err }, 'listener error'));
        await listener.start([EVENTS_CHANNEL, JOBS_CHANNEL]);
        return listener;
      },
    },
    {
      provide: QUEUE,
      inject: [ENV, DATABASE, WORKER_ID, LISTENER, DRIVERS],
      useFactory: (env: WorkerEnv, d: Database, workerId: string, listener: PgListener, drivers: DriverRegistries) =>
        createQueue(env, d.pool, workerId, pgQueueNotifier(d.pool, listener), drivers),
    },
    { provide: SECRET_STORE, inject: [ENV, DB, DRIVERS], useFactory: createSecretStore },
    { provide: BLOB_STORE, inject: [ENV, DRIVERS], useFactory: createBlobStore },
    // The audit store (ADR-032): the leader ships the outbox to it, seals, checkpoints and exports.
    {
      provide: AUDIT_STORE,
      inject: [ENV, LOGGER, DRIVERS],
      useFactory: (env: WorkerEnv, logger: Logger, drivers: DriverRegistries) =>
        createAuditStore(env, { info: (msg, fields) => logger.info(fields ?? {}, msg), warn: (msg, fields) => logger.warn(fields ?? {}, msg) }, drivers),
    },
    { provide: AUDIT_SIGNER, inject: [ENV, LOGGER], useFactory: (env: WorkerEnv, logger: Logger) => loadAuditSigner(env, { warn: (msg) => logger.warn(msg) }) },
    { provide: CHANNEL_REGISTRY, inject: [PLUGINS, DB], useFactory: (plugins: readonly OcsoPlugin[], db: Db) => createChannelRegistry({ db }, plugins) },
    {
      provide: PROVIDER_REGISTRY,
      inject: [ENV, PLUGINS],
      useFactory: (env: WorkerEnv, plugins: readonly OcsoPlugin[]) => createProviderRegistry(env, plugins),
    },
    { provide: SettingsService, inject: [DB], useFactory: (db) => new SettingsService(db) },
    // Transactional email (alert emails today): same env contract and start-up validation as the API.
    { provide: EMAIL_CONFIG, inject: [ENV, DRIVERS], useFactory: (env: WorkerEnv, drivers: DriverRegistries) => resolveEmailConfig(env, { drivers: drivers.email.list() }) },
    {
      provide: EMAIL_SENDER,
      inject: [EMAIL_CONFIG, LOGGER],
      useFactory: (config: ResolvedEmailConfig, logger: Logger) => {
        for (const warning of config.warnings) logger.warn(warning);
        return senderFor(config, { log: (line) => logger.info(line) });
      },
    },
    { provide: EMAIL_STATUS, inject: [EMAIL_CONFIG], useFactory: emailStatus },
  ],
  exports: [
    PLUGINS,
    DRIVERS,
    ENV,
    WORKER_ID,
    LOGGER,
    DATABASE,
    DB,
    LISTENER,
    QUEUE,
    SECRET_STORE,
    BLOB_STORE,
    AUDIT_STORE,
    AUDIT_SIGNER,
    CHANNEL_REGISTRY,
    PROVIDER_REGISTRY,
    SettingsService,
    EMAIL_SENDER,
    EMAIL_STATUS,
  ],
})
export class WorkerInfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LISTENER) private readonly listener: PgListener,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await shutdownOtel();
    await this.listener.stop();
    await this.auditStore.close().catch(() => {});
    await this.database.close();
  }
}
