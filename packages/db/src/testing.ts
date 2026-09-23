import { randomBytes } from 'node:crypto';
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
