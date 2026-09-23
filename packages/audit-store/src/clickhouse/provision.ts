import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AuditProvisionReport } from '../contract.js';
import { chLiteral, ClickHouseHttp } from './http.js';

export const CLICKHOUSE_AUDIT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/clickhouse', import.meta.url));

const BREAKPOINT = '--> statement-breakpoint';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface ClickHouseProvisionInput {
  url: string;
  database: string;
  adminUser?: string | undefined;
  adminPassword?: string | undefined;
  /** The writer user the api and worker use (CLICKHOUSE_USER). */
  writerUser: string;
  writerPassword?: string | undefined;
  /** Optional purge user (worker only): SELECT + ALTER DELETE on audit_records, which dropping a partition requires. */
  purgeUser?: string | undefined;
  purgePassword?: string | undefined;
  /** Optional read-only user for the api (SELECT only). */
  readerUser?: string | undefined;
  readerPassword?: string | undefined;
  provisionRole: boolean;
  /** Minimum retention the driver enforces before a purge (≥ 365). */
  minRetentionDays?: number | undefined;
  production?: boolean | undefined;
  allowOwnerWriter?: boolean | undefined;
  fetch: typeof fetch;
  migrationsDir?: string | undefined;
  log?: ((msg: string) => void) | undefined;
}

/**
 * `audit-migrate` for the clickhouse driver: creates the database, applies the
 * schema (checksummed in `audit_schema_migrations`), ensures the writer user
 * with SELECT + INSERT on the three tables — never ALTER UPDATE/DELETE — and,
 * when configured, a separate purge user with ALTER DELETE on the records only
 * (ClickHouse has no narrower grant for DROP PARTITION). Idempotent.
 */
export async function provisionClickHouseAuditStore(input: ClickHouseProvisionInput): Promise<AuditProvisionReport> {
  const log = input.log ?? (() => {});
  if (!IDENT.test(input.database)) throw new Error('CLICKHOUSE_DATABASE must be an identifier');
  if (!IDENT.test(input.writerUser)) throw new Error('CLICKHOUSE_USER must be an identifier');
  if (input.purgeUser !== undefined && (!IDENT.test(input.purgeUser) || input.purgeUser === input.writerUser)) throw new Error('CLICKHOUSE_PURGE_USER must be an identifier other than the writer');
  if (input.readerUser !== undefined && (!IDENT.test(input.readerUser) || input.readerUser === input.writerUser || input.readerUser === input.purgeUser)) throw new Error('CLICKHOUSE_READER_USER must be an identifier other than the writer and purge users');
  const minRetention = input.minRetentionDays ?? 365;
  if (!Number.isInteger(minRetention) || minRetention < 365) throw new Error('AUDIT_MIN_RETENTION_DAYS must be an integer of at least 365');
  const admin = new ClickHouseHttp({ url: input.url, database: input.database, user: input.adminUser, password: input.adminPassword, fetch: input.fetch, timeoutMs: 120_000 });
  const db = input.database;
  await admin.exec(`CREATE DATABASE IF NOT EXISTS ${db}`, { database: null });
  await admin.exec(`CREATE TABLE IF NOT EXISTS ${db}.audit_schema_migrations (name String, checksum String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY name`);
  const applied = new Map((await admin.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${db}.audit_schema_migrations`)).map((r) => [r.name, r.checksum]));
  const dir = input.migrationsDir ?? CLICKHOUSE_AUDIT_MIGRATIONS_DIR;
  const out: string[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    const text = await readFile(`${dir}/${file}`, 'utf8');
    const checksum = createHash('sha256').update(text).digest('hex');
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) throw new Error(`audit migration ${file} was modified after being applied`);
      continue;
    }
    // ClickHouse DDL is not transactional: every statement is IF NOT EXISTS so a failed file can be re-run.
    for (const statement of text.split(BREAKPOINT)) {
      const sql = statement.replace(/^\s*--.*$/gm, '').trim();
      if (sql) await admin.exec(sql.replaceAll('{database}', db));
    }
    await admin.insert(`${db}.audit_schema_migrations`, [{ name: file, checksum }]);
    out.push(file);
    log(`applied audit migration ${file}`);
  }

  await admin.insert(`${db}.audit_store_config`, [{ min_retention_days: minRetention }]);
  log(`audit store minimum retention: ${minRetention} days`);

  let roleProvisioned = false;
  if (input.adminUser === input.writerUser) {
    const message = 'the audit writer is the ClickHouse admin user: append-only privileges are not enforced';
    if (input.production && !input.allowOwnerWriter) throw new Error(`${message}. Refusing in production; set AUDIT_ALLOW_OWNER_WRITER=true to accept it`);
    log(`WARNING: ${message}`);
  } else {
    const ensureUser = async (user: string, password: string | undefined, setting: string) => {
      if (!input.provisionRole) return;
      if (!password) throw new Error(`${setting} is required to provision the ClickHouse user ${user}`);
      const secret = chLiteral(password);
      await admin.exec(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED WITH sha256_password BY ${secret}`, { database: null });
      await admin.exec(`ALTER USER ${user} IDENTIFIED WITH sha256_password BY ${secret}`, { database: null });
      roleProvisioned = true;
      log(`ensured ClickHouse user ${user}`);
    };
    await ensureUser(input.writerUser, input.writerPassword, 'AUDIT_WRITER_PASSWORD (or CLICKHOUSE_PASSWORD)');
    // ClickHouse cannot fire triggers: append-only is the grants. The writer can never UPDATE or DELETE.
    await admin.exec(`REVOKE ALL ON ${db}.* FROM ${input.writerUser}`, { database: null });
    for (const table of ['audit_records', 'audit_chain', 'audit_checkpoints']) await admin.exec(`GRANT SELECT, INSERT ON ${db}.${table} TO ${input.writerUser}`, { database: null });
    await admin.exec(`GRANT SELECT ON ${db}.audit_purges TO ${input.writerUser}`, { database: null });
    log(`granted SELECT, INSERT on the audit tables to ${input.writerUser}`);
    if (input.readerUser) {
      await ensureUser(input.readerUser, input.readerPassword, 'AUDIT_READER_PASSWORD');
      await admin.exec(`REVOKE ALL ON ${db}.* FROM ${input.readerUser}`, { database: null });
      for (const table of ['audit_records', 'audit_chain', 'audit_checkpoints', 'audit_purges']) await admin.exec(`GRANT SELECT ON ${db}.${table} TO ${input.readerUser}`, { database: null });
      log(`granted SELECT on the audit tables to the reader ${input.readerUser}`);
    }
    if (input.purgeUser) {
      await ensureUser(input.purgeUser, input.purgePassword, 'CLICKHOUSE_PURGE_PASSWORD');
      await admin.exec(`REVOKE ALL ON ${db}.* FROM ${input.purgeUser}`, { database: null });
      await admin.exec(`GRANT SELECT, ALTER DELETE ON ${db}.audit_records TO ${input.purgeUser}`, { database: null });
      await admin.exec(`GRANT SELECT, INSERT ON ${db}.audit_purges TO ${input.purgeUser}`, { database: null });
      await admin.exec(`GRANT SELECT ON ${db}.audit_store_config TO ${input.purgeUser}`, { database: null });
      log(`granted SELECT, ALTER DELETE on audit_records to ${input.purgeUser} (partition drops past retention)`);
    }
  }
  return { applied: out, writer: input.writerUser, reader: input.readerUser ?? null, roleProvisioned };
}
