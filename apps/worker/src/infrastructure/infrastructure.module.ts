import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SettingsService } from '@ocso/application';
import { PgListener, createBlobStore, createChannelRegistry, createQueue, createSecretStore, pgQueueNotifier } from '@ocso/bootstrap';
import { WorkerEnv, assertDriverConfig, loadEnv } from '@ocso/config';
import { createDatabase, type Database } from '@ocso/db';
import { emailStatus, resolveEmailConfig, senderFor, type ResolvedEmailConfig } from '@ocso/email';
import { createLogger, type Logger } from '@ocso/observability';
import { shutdownOtel } from '@ocso/observability/otel';
import { EVENTS_CHANNEL } from '@ocso/application';
import { JOBS_CHANNEL } from '@ocso/bootstrap';
import { BLOB_STORE, CHANNEL_REGISTRY, DATABASE, DB, EMAIL_CONFIG, EMAIL_SENDER, EMAIL_STATUS, ENV, LISTENER, LOGGER, QUEUE, SECRET_STORE, WORKER_ID } from './tokens.js';

function loadWorkerEnv(): WorkerEnv {
  const env = loadEnv(WorkerEnv);
  assertDriverConfig(env);
  return env;
}

/** Worker infrastructure: same adapters as the API, selected by configuration (build rule §17). */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: loadWorkerEnv },
    { provide: WORKER_ID, inject: [ENV], useFactory: (env: WorkerEnv) => env.WORKER_ID ?? `wkr-${randomBytes(3).toString('hex').slice(0, 5)}` },
    {
      provide: LOGGER,
      inject: [ENV, WORKER_ID],
      useFactory: (env: WorkerEnv, workerId: string) =>
        createLogger({ service: 'ocso-worker', version: env.APP_VERSION, level: env.LOG_LEVEL }).child({ workerId }),
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
      inject: [ENV, DATABASE, WORKER_ID, LISTENER],
      useFactory: (env: WorkerEnv, d: Database, workerId: string, listener: PgListener) =>
        createQueue(env, d.pool, workerId, pgQueueNotifier(d.pool, listener)),
    },
    { provide: SECRET_STORE, inject: [ENV, DB], useFactory: createSecretStore },
    { provide: BLOB_STORE, inject: [ENV], useFactory: createBlobStore },
    { provide: CHANNEL_REGISTRY, useFactory: () => createChannelRegistry() },
    { provide: SettingsService, inject: [DB], useFactory: (db) => new SettingsService(db) },
    // Transactional email (alert emails today): same env contract and start-up validation as the API.
    { provide: EMAIL_CONFIG, inject: [ENV], useFactory: (env: WorkerEnv) => resolveEmailConfig(env) },
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
  exports: [ENV, WORKER_ID, LOGGER, DATABASE, DB, LISTENER, QUEUE, SECRET_STORE, BLOB_STORE, CHANNEL_REGISTRY, SettingsService, EMAIL_SENDER, EMAIL_STATUS],
})
export class WorkerInfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LISTENER) private readonly listener: PgListener,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await shutdownOtel();
    await this.listener.stop();
    await this.database.close();
  }
}
