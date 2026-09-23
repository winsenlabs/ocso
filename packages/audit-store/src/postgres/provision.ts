import pg from 'pg';
import type { AuditProvisionReport } from '../contract.js';
import { ROLE_NAME, urlCredentials } from '../settings.js';
import { POSTGRES_AUDIT_MIGRATIONS_DIR, runAuditMigrations } from './migrate.js';

export interface PostgresProvisionInput {
  /** Owner connection to the audit database (creates tables, functions, the writer role). */
  ownerUrl: string;
  /** The writer's connection URL (the api/worker AUDIT_DATABASE_URL); its user is the writer role. */
  writerUrl: string;
  /** Password for the writer role; default the one in `writerUrl`. */
  writerPassword?: string | undefined;
  /** The api's read-only connection URL; its user becomes the reader role (SELECT only). */
  readerUrl?: string | undefined;
  /** Password for the reader role; default the one in `readerUrl`. */
  readerPassword?: string | undefined;
  /** false = the DBA created the writer role (managed databases): only grants are applied. */
  provisionRole: boolean;
  /** The store's minimum retention (≥ 365): audit_purge_before never removes anything younger. */
  minRetentionDays?: number | undefined;
  /** Production refuses a writer that is the owner or a superuser unless this is set. */
  production?: boolean | undefined;
  allowOwnerWriter?: boolean | undefined;
  ssl?: boolean | undefined;
  migrationsDir?: string | undefined;
  log?: ((msg: string) => void) | undefined;
}

const TABLES = 'audit_records, audit_chain, audit_checkpoints';

/**
 * `audit-migrate` for the postgres driver: applies the schema as the owner,
 * ensures the writer role (LOGIN, no other attributes) with its password, and
 * grants it exactly INSERT/SELECT on the three tables, the ingest sequence and
 * EXECUTE on audit_ensure_partitions / audit_purge_before. Idempotent.
 */
export async function provisionPostgresAuditStore(input: PostgresProvisionInput): Promise<AuditProvisionReport> {
  const log = input.log ?? (() => {});
  const { user: writer, password: urlPassword } = urlCredentials(input.writerUrl);
  if (!ROLE_NAME.test(writer)) throw new Error(`audit writer role "${writer}" must be lower case a-z, 0-9 and _`);
  const reader = input.readerUrl ? urlCredentials(input.readerUrl) : null;
  if (reader && (!ROLE_NAME.test(reader.user) || reader.user === writer)) throw new Error(`audit reader role "${reader.user}" must be lower case a-z, 0-9 and _, and not the writer`);
  const minRetention = input.minRetentionDays ?? 365;
  if (!Number.isInteger(minRetention) || minRetention < 365) throw new Error('AUDIT_MIN_RETENTION_DAYS must be an integer of at least 365');
  const owner = await connectCreatingDatabase(input.ownerUrl, input.ssl ?? false, log);
  try {
    const applied = await runAuditMigrations(owner, input.migrationsDir ?? POSTGRES_AUDIT_MIGRATIONS_DIR, log);
    const { rows } = await owner.query<{ me: string; db: string }>('SELECT current_user AS me, current_database() AS db');
    const { me, db } = rows[0]!;
    await owner.query('UPDATE audit_store_config SET min_retention_days = $1', [minRetention]);
    log(`audit store minimum retention: ${minRetention} days`);
    let roleProvisioned = false;
    const ensureRole = async (role: string, password: string | undefined, setting: string) => {
      const exists = (await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
      if (input.provisionRole) {
        if (!password) throw new Error(`${setting} is required to provision the audit role ${role}`);
        const verb = exists ? 'ALTER' : 'CREATE';
        await owner.query(`${verb} ROLE ${owner.escapeIdentifier(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${owner.escapeLiteral(password)}`);
        roleProvisioned = true;
        log(`${exists ? 'updated' : 'created'} audit role ${role}`);
        return;
      }
      if (!exists) throw new Error(`audit role ${role} does not exist: create it, or set AUDIT_PROVISION_ROLE=true`);
      const { rows: attrs } = await owner.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [role]);
      if (attrs[0]?.rolsuper) refuseOwnerWriter(input, `audit role ${role} is a superuser: append-only is not enforced`, log);
    };
    if (me === writer) {
      refuseOwnerWriter(input, 'the audit writer is the database owner: append-only privileges are not enforced (use a separate writer role)', log);
    } else {
      await ensureRole(writer, input.writerPassword || urlPassword, 'AUDIT_WRITER_PASSWORD (or a password in AUDIT_DATABASE_URL)');
      const ident = owner.escapeIdentifier(writer);
      await owner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await owner.query(`GRANT CONNECT ON DATABASE ${owner.escapeIdentifier(db)} TO ${ident}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
      await owner.query(`REVOKE ALL ON ${TABLES}, audit_purges, audit_store_config FROM ${ident}`);
      await owner.query(`GRANT SELECT, INSERT ON ${TABLES} TO ${ident}`);
      await owner.query(`GRANT SELECT ON audit_purges TO ${ident}`);
      await owner.query(`GRANT USAGE ON SEQUENCE audit_records_ingest_seq TO ${ident}`);
      await owner.query(`GRANT EXECUTE ON FUNCTION audit_ensure_partitions(integer, timestamptz), audit_purge_before(timestamptz) TO ${ident}`);
      log(`granted INSERT/SELECT on ${TABLES} to ${writer}`);
    }
    if (reader && reader.user !== me) {
      await ensureRole(reader.user, input.readerPassword || reader.password, 'AUDIT_READER_PASSWORD (or a password in AUDIT_READER_URL)');
      const ident = owner.escapeIdentifier(reader.user);
      await owner.query(`GRANT CONNECT ON DATABASE ${owner.escapeIdentifier(db)} TO ${ident}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
      await owner.query(`REVOKE ALL ON ${TABLES}, audit_purges, audit_store_config FROM ${ident}`);
      await owner.query(`REVOKE ALL ON FUNCTION audit_ensure_partitions(integer, timestamptz), audit_purge_before(timestamptz) FROM ${ident}`);
      await owner.query(`GRANT SELECT ON ${TABLES}, audit_purges TO ${ident}`);
      log(`granted SELECT on the audit tables to the reader ${reader.user}`);
    }
    await owner.query('SELECT audit_ensure_partitions(3)');
    return { applied, writer, reader: reader?.user ?? null, roleProvisioned };
  } finally {
    await owner.end();
  }
}

function refuseOwnerWriter(input: PostgresProvisionInput, message: string, log: (msg: string) => void): void {
  if (input.production && !input.allowOwnerWriter) throw new Error(`${message}. Refusing in production; set AUDIT_ALLOW_OWNER_WRITER=true to accept it`);
  log(`WARNING: ${message}`);
}

/**
 * The owner connection; when the audit database does not exist yet (a managed
 * server where only the instance was created, e.g. RDS), it is created first
 * through the server's `postgres` database with the same credentials.
 */
async function connectCreatingDatabase(ownerUrl: string, ssl: boolean, log: (msg: string) => void): Promise<pg.Client> {
  const connect = async (url: string) => {
    const client = new pg.Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: true } : undefined, application_name: 'ocso-audit-migrate' });
    await client.connect();
    return client;
  };
  try {
    return await connect(ownerUrl);
  } catch (err) {
    if ((err as { code?: string }).code !== '3D000') throw err;
    const target = new URL(ownerUrl);
    const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
    const maintenance = new URL(ownerUrl);
    maintenance.pathname = '/postgres';
    const admin = await connect(maintenance.toString());
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
      log(`created audit database ${name}`);
    } finally {
      await admin.end();
    }
    return connect(ownerUrl);
  }
}
