import type { AuditDriverEnv, AuditToolsEnv } from '@ocso/config';
import { ClickHouseHttp } from './clickhouse/http.js';
import { provisionClickHouseAuditStore } from './clickhouse/provision.js';
import { ClickHouseAuditStore } from './clickhouse/store.js';
import type { AuditStoreDriverDefinition } from './contract.js';
import { provisionPostgresAuditStore } from './postgres/provision.js';
import { PostgresAuditStore } from './postgres/store.js';
import { settingOrFile } from './settings.js';

/** First-party audit store drivers (an OcsoPlugin contribution; AUDIT_DRIVER selects one). */
export type AuditDriverDefinition = AuditStoreDriverDefinition<AuditDriverEnv, AuditToolsEnv>;

const writerUrl = (env: AuditDriverEnv) => settingOrFile(env.AUDIT_DATABASE_URL, env.AUDIT_DATABASE_URL_FILE);

/** Its own PostgreSQL database; the worker connects as the writer role, the api as the reader where one is provisioned. */
export const postgresAuditDriver: AuditDriverDefinition = {
  name: 'postgres',
  check: (env) => (env.AUDIT_DATABASE_URL || env.AUDIT_DATABASE_URL_FILE ? [] : ['AUDIT_DRIVER=postgres requires AUDIT_DATABASE_URL (or AUDIT_DATABASE_URL_FILE)']),
  create: (env, { logger }) =>
    new PostgresAuditStore({
      connectionString: writerUrl(env)!,
      poolSize: env.AUDIT_DATABASE_POOL_SIZE,
      ssl: env.AUDIT_DATABASE_SSL ?? false,
      applicationName: 'ocso-audit',
      timeoutMs: env.AUDIT_STORE_TIMEOUT_MS,
      onError: (err) => logger.warn('idle audit database connection lost; the pool reconnects', { code: (err as { code?: string }).code ?? null }),
    }),
  provision: async (env, { log }) => {
    const owner = settingOrFile(env.AUDIT_DATABASE_OWNER_URL, env.AUDIT_DATABASE_OWNER_URL_FILE);
    const writer = writerUrl(env);
    if (!owner || !writer) throw new Error('audit-migrate (postgres) needs AUDIT_DATABASE_OWNER_URL and AUDIT_DATABASE_URL (or their _FILE forms)');
    return provisionPostgresAuditStore({
      ownerUrl: owner,
      writerUrl: writer,
      writerPassword: settingOrFile(env.AUDIT_WRITER_PASSWORD, env.AUDIT_WRITER_PASSWORD_FILE),
      readerUrl: settingOrFile(env.AUDIT_READER_URL, env.AUDIT_READER_URL_FILE),
      readerPassword: settingOrFile(env.AUDIT_READER_PASSWORD, env.AUDIT_READER_PASSWORD_FILE),
      provisionRole: env.AUDIT_PROVISION_ROLE,
      minRetentionDays: env.AUDIT_MIN_RETENTION_DAYS,
      production: env.NODE_ENV === 'production',
      allowOwnerWriter: env.AUDIT_ALLOW_OWNER_WRITER,
      ssl: env.AUDIT_DATABASE_SSL ?? false,
      log,
    });
  },
};

/** ClickHouse over its HTTP interface (the injected fetch); the writer user has SELECT/INSERT only. */
export const clickhouseAuditDriver: AuditDriverDefinition = {
  name: 'clickhouse',
  check: (env) => {
    const problems: string[] = [];
    if (!env.CLICKHOUSE_URL) problems.push('AUDIT_DRIVER=clickhouse requires CLICKHOUSE_URL');
    if (!env.CLICKHOUSE_USER) problems.push('AUDIT_DRIVER=clickhouse requires CLICKHOUSE_USER (the writer user)');
    if (env.CLICKHOUSE_PURGE_USER && env.CLICKHOUSE_PURGE_USER === env.CLICKHOUSE_USER) problems.push('CLICKHOUSE_PURGE_USER must not be the writer user');
    return problems;
  },
  create: (env, deps) => {
    const http = (user: string | undefined, password: string | undefined) =>
      new ClickHouseHttp({ url: env.CLICKHOUSE_URL!, database: env.CLICKHOUSE_DATABASE, user, password, fetch: deps.fetch ?? fetch, timeoutMs: env.AUDIT_STORE_TIMEOUT_MS });
    const purge = env.CLICKHOUSE_PURGE_USER ? http(env.CLICKHOUSE_PURGE_USER, settingOrFile(env.CLICKHOUSE_PURGE_PASSWORD, env.CLICKHOUSE_PURGE_PASSWORD_FILE)) : null;
    return new ClickHouseAuditStore(http(env.CLICKHOUSE_USER, settingOrFile(env.CLICKHOUSE_PASSWORD, env.CLICKHOUSE_PASSWORD_FILE)), purge);
  },
  provision: async (env, { log }) => {
    if (!env.CLICKHOUSE_URL || !env.CLICKHOUSE_USER) throw new Error('audit-migrate (clickhouse) needs CLICKHOUSE_URL and CLICKHOUSE_USER');
    return provisionClickHouseAuditStore({
      url: env.CLICKHOUSE_URL,
      database: env.CLICKHOUSE_DATABASE,
      adminUser: env.CLICKHOUSE_ADMIN_USER,
      adminPassword: settingOrFile(env.CLICKHOUSE_ADMIN_PASSWORD, env.CLICKHOUSE_ADMIN_PASSWORD_FILE),
      writerUser: env.CLICKHOUSE_USER,
      writerPassword: settingOrFile(env.AUDIT_WRITER_PASSWORD, env.AUDIT_WRITER_PASSWORD_FILE) ?? settingOrFile(env.CLICKHOUSE_PASSWORD, env.CLICKHOUSE_PASSWORD_FILE),
      purgeUser: env.CLICKHOUSE_PURGE_USER,
      purgePassword: settingOrFile(env.CLICKHOUSE_PURGE_PASSWORD, env.CLICKHOUSE_PURGE_PASSWORD_FILE),
      readerUser: env.CLICKHOUSE_READER_USER,
      readerPassword: settingOrFile(env.AUDIT_READER_PASSWORD, env.AUDIT_READER_PASSWORD_FILE),
      provisionRole: env.AUDIT_PROVISION_ROLE,
      minRetentionDays: env.AUDIT_MIN_RETENTION_DAYS,
      production: env.NODE_ENV === 'production',
      allowOwnerWriter: env.AUDIT_ALLOW_OWNER_WRITER,
      fetch,
      log,
    });
  },
};

/** The drivers this package contributes, in registration order. */
export const AUDIT_STORE_DRIVERS: readonly AuditDriverDefinition[] = [postgresAuditDriver, clickhouseAuditDriver];
