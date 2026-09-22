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
 * 0019_message_templates: templates submitted before the plugin-boundary
 * refactor (table `whatsapp_templates`) survive the rename to
 * `message_templates` with their ids, constraints and indexes.
 */

const RENAME = '0019_message_templates.sql';
const name = `ocso_test_${randomBytes(6).toString('hex')}`;
let database: Database;
let before: string;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  database = createDatabase({ connectionString: url.toString(), maxConnections: 2, applicationName: 'ocso-test' });
  before = await mkdtemp(join(tmpdir(), 'ocso-migrations-'));
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < RENAME)) await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
  await runMigrations(database.pool, before);
});
afterAll(async () => {
  await database?.close();
  if (before) await rm(before, { recursive: true, force: true });
  const cleanup = new pg.Client({ connectionString: testAdminUrl() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await cleanup.end();
});

describe('message templates rename', () => {
  it('keeps existing rows and renames the table, keys and indexes', async () => {
    const q = (text: string, params: unknown[] = []) => database.pool.query(text, params);
    const [channel, template] = [uuidv7(), uuidv7()];
    await q(`INSERT INTO channels (id, kind, name, public_key) VALUES ($1, 'TWILIO_WHATSAPP', 'WhatsApp', 'pk_rename_test')`, [channel]);
    await q(
      `INSERT INTO whatsapp_templates (id, channel_id, provider_template_id, name, language, category, status, definition)
       VALUES ($1, $2, 'HX0f0e72ce92eef937d6f481b338ecbd19', 'order_ready', 'en', 'UTILITY', 'PENDING', '{}')`,
      [template, channel],
    );

    const result = await runMigrations(database.pool, MIGRATIONS_DIR);
    expect(result.applied[0]).toBe(RENAME);

    const { rows } = await q(`SELECT id, name, status FROM message_templates`);
    expect(rows).toEqual([{ id: template, name: 'order_ready', status: 'PENDING' }]);
    expect((await q(`SELECT to_regclass('whatsapp_templates') AS t`)).rows[0]).toEqual({ t: null });
    const names = await q(
      `SELECT conname AS n FROM pg_constraint WHERE conrelid = 'message_templates'::regclass
       UNION ALL SELECT indexname FROM pg_indexes WHERE tablename = 'message_templates' ORDER BY 1`,
    );
    expect(names.rows.map((r: { n: string }) => r.n).every((n: string) => n.startsWith('message_templates_'))).toBe(true);
    // The partial unique index still guards duplicate live names per channel.
    await expect(
      q(`INSERT INTO message_templates (id, channel_id, provider_template_id, name, language, category, status, definition) VALUES ($1, $2, 'HX2', 'order_ready', 'en', 'UTILITY', 'PENDING', '{}')`, [uuidv7(), channel]),
    ).rejects.toThrow(/message_templates_name_uq/);
  });
});
