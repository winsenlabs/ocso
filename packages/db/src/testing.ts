import { randomBytes } from 'node:crypto';
import type { AuditStore } from '@ocso/audit-store';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDatabase, type Database } from './client.js';
import { runMigrations } from './migrate.js';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Admin connection used to create throwaway databases for integration tests. */
export function testAdminUrl(): string {
  return process.env['OCSO_TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/postgres';
}

export interface TestDatabase extends Database {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** Create an isolated, fully migrated database. Always call `drop()` in afterAll. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = testAdminUrl();
  const name = `ocso_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = createDatabase({ connectionString: url.toString(), maxConnections: 8, applicationName: 'ocso-test' });
  await runMigrations(database.pool, MIGRATIONS_DIR);
  return {
    ...database,
    name,
    url: url.toString(),
    async drop() {
      await database.close();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export interface TestAuditDatabase {
  name: string;
  /** Writer connection (the api/worker AUDIT_DATABASE_URL): INSERT/SELECT only. */
  url: string;
  /** Owner connection (the test server's admin): can tamper, for verification tests. */
  ownerUrl: string;
  /** The per-database writer role (roles are cluster-wide, so each test database gets its own). */
  role: string;
  /** A postgres audit store on the writer URL (close it before drop). */
  openStore(): Promise<AuditStore>;
  drop(): Promise<void>;
}

/**
 * A throwaway audit store database (ADR-032) on the same server as
 * createTestDatabase: created, provisioned by the audit-migrate code path
 * (schema, writer role, grants). Always call `drop()` in afterAll.
 */
export async function createTestAuditDatabase(): Promise<TestAuditDatabase> {
  const { PostgresAuditStore, provisionPostgresAuditStore } = await import('@ocso/audit-store');
  const adminUrl = testAdminUrl();
  const suffix = randomBytes(6).toString('hex');
  const name = `ocso_audit_test_${suffix}`;
  const role = `ocso_audit_w_${suffix}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const owner = new URL(adminUrl);
  owner.pathname = `/${name}`;
  const writer = new URL(owner.toString());
  writer.username = role;
  writer.password = randomBytes(12).toString('hex');
  await provisionPostgresAuditStore({ ownerUrl: owner.toString(), writerUrl: writer.toString(), provisionRole: true });
  return {
    name,
    url: writer.toString(),
    ownerUrl: owner.toString(),
    role,
    openStore: async () => new PostgresAuditStore({ connectionString: writer.toString(), poolSize: 3 }),
    async drop() {
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
      await cleanup.end();
    },
  };
}
