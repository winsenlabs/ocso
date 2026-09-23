import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { SettingsService, SetupService, generatedSetupToken } from '@ocso/application';
import {
  assertDrivers,
  createAuditStore,
  createBlobStore,
  createChannelRegistry,
  createDriverRegistries,
  createProviderRegistry,
  createQueue,
  createSecretStore,
  loadAuditSigner,
  loadPlugins,
  pluginSummary,
  type DriverRegistries,
  type OcsoPlugin,
} from '@ocso/bootstrap';
import type { AuditStore } from '@ocso/application';
import { ApiEnv, assertDriverConfig, loadEnv } from '@ocso/config';
import { createDatabase, type Database, type Db } from '@ocso/db';
import { emailStatus, resolveEmailConfig, senderFor, type ResolvedEmailConfig } from '@ocso/email';
import { AUTH_EXPORTS, AUTH_PROVIDERS } from './auth.providers.js';
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
 * FIRST_PARTY_PLUGINS plus the installed plugins OCSO_PLUGINS pins (read from
 * the raw environment: loadEnv strips unknown keys). A bad list stops start-up.
 * The worker loads the same list and logs the same line, so the two can be compared.
 */
export async function loadApiPlugins(log: (line: string) => void = (line) => new Logger('Plugins').log(line)): Promise<readonly OcsoPlugin[]> {
  const plugins = await loadPlugins();
  log(pluginSummary(plugins, process.env['APP_VERSION'] ?? 'dev'));
  return plugins;
}

/**
 * Global infrastructure bindings. Registries and adapters come from the
 * composition root (@ocso/bootstrap) — built from PLUGINS, selected by
 * configuration; modules depend on tokens, never on AWS/pg directly.
 */
@Global()
@Module({
  providers: [
    { provide: PLUGINS, useFactory: () => loadApiPlugins() },
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
    // The audit store (ADR-032): reads go through it; writes stay in the main database's outbox.
    {
      provide: AUDIT_STORE,
      inject: [ENV, DRIVERS],
      useFactory: (env: ApiEnv, drivers: DriverRegistries) => {
        const logger = new Logger('AuditStore');
        return createAuditStore(env, { info: (msg) => logger.log(msg), warn: (msg, fields) => logger.warn(fields ? `${msg} ${JSON.stringify(fields)}` : msg) }, drivers);
      },
    },
    { provide: AUDIT_SIGNER, inject: [ENV], useFactory: (env: ApiEnv) => loadAuditSigner(env, new Logger('AuditStore')) },
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
    AUDIT_STORE,
    AUDIT_SIGNER,
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
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Flush telemetry before the pool closes (research/04 §7 gotcha 3).
    await (globalThis as { __ocsoOtelSdk?: { shutdown(): Promise<void> } }).__ocsoOtelSdk?.shutdown().catch(() => {});
    await this.auditStore.close().catch(() => {});
    await this.database.close();
  }
}
