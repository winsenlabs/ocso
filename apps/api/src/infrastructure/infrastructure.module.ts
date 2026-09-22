import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { SettingsService, SetupService, generatedSetupToken } from '@ocso/application';
import { createBlobStore, createChannelRegistry, createQueue, createSecretStore } from '@ocso/bootstrap';
import { ApiEnv, assertDriverConfig, loadEnv } from '@ocso/config';
import { createDatabase, type Database } from '@ocso/db';
import { emailStatus, resolveEmailConfig, senderFor, type ResolvedEmailConfig } from '@ocso/email';
import { AUTH_EXPORTS, AUTH_PROVIDERS } from './auth.providers.js';
import { BLOB_STORE, CHANNEL_REGISTRY, DATABASE, DB, EMAIL_CONFIG, EMAIL_SENDER, EMAIL_STATUS, ENV, QUEUE, SECRET_STORE, SETUP_TOKEN } from './tokens.js';

function loadApiEnv(): ApiEnv {
  const env = loadEnv(ApiEnv);
  assertDriverConfig(env);
  return env;
}

/**
 * Global infrastructure bindings. Adapters are chosen by configuration in one
 * place (@ocso/bootstrap); modules depend on tokens, never on AWS/pg directly.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: loadApiEnv },
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: ApiEnv): Database =>
        createDatabase({ connectionString: env.DATABASE_URL, maxConnections: env.DATABASE_POOL_SIZE, applicationName: 'ocso-api', ssl: env.DATABASE_SSL }),
    },
    { provide: DB, inject: [DATABASE], useFactory: (d: Database) => d.db },
    { provide: SECRET_STORE, inject: [ENV, DB], useFactory: createSecretStore },
    { provide: BLOB_STORE, inject: [ENV], useFactory: createBlobStore },
    { provide: CHANNEL_REGISTRY, useFactory: () => createChannelRegistry() },
    {
      provide: QUEUE,
      inject: [ENV, DATABASE],
      useFactory: (env: ApiEnv, d: Database) => createQueue(env, d.pool, `api-${hostname()}`),
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
    { provide: EMAIL_CONFIG, inject: [ENV], useFactory: (env: ApiEnv) => resolveEmailConfig(env) },
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
  exports: [ENV, DATABASE, DB, SECRET_STORE, BLOB_STORE, CHANNEL_REGISTRY, QUEUE, SETUP_TOKEN, SettingsService, SetupService, EMAIL_SENDER, EMAIL_STATUS, ...AUTH_EXPORTS],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    // Flush telemetry before the pool closes (research/04 §7 gotcha 3).
    await (globalThis as { __ocsoOtelSdk?: { shutdown(): Promise<void> } }).__ocsoOtelSdk?.shutdown().catch(() => {});
    await this.database.close();
  }
}
