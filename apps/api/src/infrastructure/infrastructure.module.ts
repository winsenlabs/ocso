import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { hostname } from 'node:os';
import { SessionService, SettingsService, SetupService, generatedSetupToken } from '@ocso/application';
import { createBlobStore, createChannelRegistry, createQueue, createSecretStore } from '@ocso/bootstrap';
import { ApiEnv, assertDriverConfig, loadEnv } from '@ocso/config';
import { createDatabase, type Database } from '@ocso/db';
import { BLOB_STORE, CHANNEL_REGISTRY, DATABASE, DB, ENV, QUEUE, SECRET_STORE, SETUP_TOKEN } from './tokens.js';

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
    {
      provide: SessionService,
      inject: [DB, ENV],
      useFactory: (db, env: ApiEnv) =>
        new SessionService(db, { idleMinutes: env.SESSION_IDLE_MINUTES, absoluteHours: env.SESSION_ABSOLUTE_HOURS, maxFailures: 8, failureWindowMinutes: 15 }),
    },
    { provide: SettingsService, inject: [DB], useFactory: (db) => new SettingsService(db) },
    { provide: SetupService, inject: [DB, SETUP_TOKEN], useFactory: (db, token: string) => new SetupService(db, token) },
  ],
  exports: [ENV, DATABASE, DB, SECRET_STORE, BLOB_STORE, CHANNEL_REGISTRY, QUEUE, SETUP_TOKEN, SessionService, SettingsService, SetupService],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    // Flush telemetry before the pool closes (research/04 §7 gotcha 3).
    await (globalThis as { __ocsoOtelSdk?: { shutdown(): Promise<void> } }).__ocsoOtelSdk?.shutdown().catch(() => {});
    await this.database.close();
  }
}
