import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { SettingsService, SetupService, generatedSetupToken } from '@ocso/application';
import {
  FIRST_PARTY_PLUGINS,
  assertDrivers,
  createBlobStore,
  createChannelRegistry,
  createDriverRegistries,
  createProviderRegistry,
  createQueue,
  createSecretStore,
  type DriverRegistries,
  type OcsoPlugin,
} from '@ocso/bootstrap';
import { ApiEnv, assertDriverConfig, loadEnv } from '@ocso/config';
import { createDatabase, type Database, type Db } from '@ocso/db';
import { emailStatus, resolveEmailConfig, senderFor, type ResolvedEmailConfig } from '@ocso/email';
import { AUTH_EXPORTS, AUTH_PROVIDERS } from './auth.providers.js';
import {
  BLOB_STORE,
  CHANNEL_REGISTRY,
  DATABASE,
  DB,
  DRIVERS,
  EMAIL_CONFIG,
  EMAIL_SENDER,
  EMAIL_STATUS,
  ENV,
  PLUGINS,
  PROVIDER_REGISTRY,
  QUEUE,
  SECRET_STORE,
  SETUP_TOKEN,
} from './tokens.js';

function loadApiEnv(drivers: DriverRegistries): ApiEnv {
  const env = loadEnv(ApiEnv);
  assertDriverConfig(env);
  assertDrivers(env, drivers);
  return env;
}

/**
 * Global infrastructure bindings. Registries and adapters come from the
 * composition root (@ocso/bootstrap) — built from PLUGINS, selected by
 * configuration; modules depend on tokens, never on AWS/pg directly.
 */
@Global()
@Module({
  providers: [
    { provide: PLUGINS, useValue: FIRST_PARTY_PLUGINS },
    { provide: DRIVERS, inject: [PLUGINS], useFactory: (plugins: readonly OcsoPlugin[]) => createDriverRegistries(plugins) },
    { provide: ENV, inject: [DRIVERS], useFactory: loadApiEnv },
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: ApiEnv): Database =>
        createDatabase({ connectionString: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_SIZE, applicationName: 'ocso-api', ssl: env.DATABASE_SSL }),
    },
    { provide: DB, inject: [DATABASE], useFactory: (d: Database) => d.db },
    { provide: SECRET_STORE, inject: [ENV, DB, DRIVERS], useFactory: createSecretStore },
    { provide: BLOB_STORE, inject: [ENV, DRIVERS], useFactory: createBlobStore },
    { provide: CHANNEL_REGISTRY, inject: [PLUGINS, DB], useFactory: (plugins: readonly OcsoPlugin[], db: Db) => createChannelRegistry({ db }, plugins) },
    {
      provide: PROVIDER_REGISTRY,
      inject: [ENV, PLUGINS],
      useFactory: (env: ApiEnv, plugins: readonly OcsoPlugin[]) => createProviderRegistry(env, plugins),
    },
    {
      provide: QUEUE,
      inject: [ENV, DATABASE, DRIVERS],
      useFactory: (env: ApiEnv, d: Database, drivers: DriverRegistries) => createQueue(env, d.pool, `api-${hostname()}`, undefined, drivers),
    },
    {
      provide: SETUP_TOKEN,
      inject: [ENV],
      useFactory: (env: ApiEnv) => env.OCSO_SETUP_TOKEN ?? generatedSetupToken(),
    },
    ...AUTH_PROVIDERS,
    { provide: SettingsService, inject: [DB], useFactory: (db) => new SettingsService(db) },
    { provide: SetupService, inject: [DB, SETUP_TOKEN], useFactory: (db, token: string) => new SetupService(db, token) },
    // Transactional email: validated at start-up (fails fast on bad config, and on the log driver in production).
    { provide: EMAIL_CONFIG, inject: [ENV, DRIVERS], useFactory: (env: ApiEnv, drivers: DriverRegistries) => resolveEmailConfig(env, { drivers: drivers.email.list() }) },
    {
      provide: EMAIL_SENDER,
      inject: [EMAIL_CONFIG],
      useFactory: (config: ResolvedEmailConfig) => {
        const logger = new Logger('Email');
        for (const warning of config.warnings) logger.warn(warning);
        return senderFor(config, { log: (line) => logger.log(line) });
      },
    },
    { provide: EMAIL_STATUS, inject: [EMAIL_CONFIG], useFactory: emailStatus },
  ],
  exports: [
    PLUGINS,
    DRIVERS,
    ENV,
    DATABASE,
    DB,
    SECRET_STORE,
    BLOB_STORE,
    CHANNEL_REGISTRY,
    PROVIDER_REGISTRY,
    QUEUE,
    SETUP_TOKEN,
    SettingsService,
    SetupService,
    EMAIL_SENDER,
    EMAIL_STATUS,
    ...AUTH_EXPORTS,
  ],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    // Flush telemetry before the pool closes (research/04 §7 gotcha 3).
    await (globalThis as { __ocsoOtelSdk?: { shutdown(): Promise<void> } }).__ocsoOtelSdk?.shutdown().catch(() => {});
    await this.database.close();
  }
}
