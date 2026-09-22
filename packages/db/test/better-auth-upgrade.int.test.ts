import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { uuidv7 } from '../src/ids.js';
import { MIGRATIONS_DIR, testAdminUrl } from '../src/testing.js';

/**
 * ADR-025 upgrade (0014_better_auth + 0015_drop_legacy_sessions): a deployment
 * with users, password hashes and live sessions keeps its passwords as
 * Better Auth credential accounts; emails become lower case; old sessions go.
 */
const FIRST = '0014_better_auth.sql';
const name = `ocso_test_${randomBytes(6).toString('hex')}`;
let database: Database;
let before: string;
const ids = { admin: uuidv7(), invited: uuidv7() };

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  database = createDatabase({ connectionString: url.toString(), maxConnections: 2, applicationName: 'ocso-test' });
  before = await mkdtemp(join(tmpdir(), 'ocso-migrations-'));
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < FIRST)) await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
  await runMigrations(database.pool, before);
  await database.pool.query(`INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, 'Tejas@Meridian.Test', 'Tejas', 'PLATFORM_TECH_ADMIN', 'scrypt$15$8$1$c2FsdA==$aGFzaA==')`, [ids.admin]);
  await database.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'no-password@meridian.test', 'Nobody', 'CS_EXEC')`, [ids.invited]);
  await database.pool.query(`INSERT INTO sessions (id, token_hash, user_id, idle_expires_at, expires_at) VALUES ($1, 'hash', $2, now() + interval '1 hour', now() + interval '1 day')`, [uuidv7(), ids.admin]);
  await runMigrations(database.pool, MIGRATIONS_DIR);
});
afterAll(async () => {
  await database?.close();
  if (before) await rm(before, { recursive: true, force: true });
  const cleanup = new pg.Client({ connectionString: testAdminUrl() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await cleanup.end();
});

describe('0014/0015 Better Auth upgrade', () => {
  it('moves password hashes into credential accounts unchanged', async () => {
    const { rows } = await database.pool.query(`SELECT user_id, account_id, provider_id, password FROM auth_accounts`);
    expect(rows).toEqual([{ user_id: ids.admin, account_id: ids.admin, provider_id: 'credential', password: 'scrypt$15$8$1$c2FsdA==$aGFzaA==' }]);
  });

  it('lower-cases emails and marks existing password users verified', async () => {
    const { rows } = await database.pool.query(`SELECT id, email, email_verified FROM users ORDER BY email`);
    expect(rows).toEqual([
      { id: ids.invited, email: 'no-password@meridian.test', email_verified: false },
      { id: ids.admin, email: 'tejas@meridian.test', email_verified: true },
    ]);
  });

  it('drops the hand-built sessions and the password column, and creates the auth policy row', async () => {
    const { rows } = await database.pool.query(
      `SELECT (SELECT to_regclass('public.sessions')::text) AS sessions,
              (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash') AS password_hash,
              (SELECT count(*)::int FROM auth_policy) AS policy`,
    );
    expect(rows[0]).toEqual({ sessions: null, password_hash: 0, policy: 1 });
  });
});
