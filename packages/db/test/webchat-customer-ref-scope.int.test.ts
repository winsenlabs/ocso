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
 * 0033_webchat_customer_ref_scope: bare `webchat_customer_ref` values (before verified web chat user ids were
 * scoped per channel) become `<channel id>:<sub>` when the customer's web chat channel is known; ambiguous or
 * unattributable rows stay as they were.
 */

const SCOPE = '0033_webchat_customer_ref_scope.sql';
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
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < SCOPE)) await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
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

describe('web chat customer ref scoping', () => {
  it('namespaces refs whose web chat channel is known and leaves the rest', async () => {
    const q = (text: string, params: unknown[] = []) => database.pool.query(text, params);
    const [siteA, siteB, whatsapp] = [uuidv7(), uuidv7(), uuidv7()];
    await q(
      `INSERT INTO channels (id, kind, name, status, public_key) VALUES
         ($1, 'WEBCHAT', 'A', 'ACTIVE', 'pk_a'), ($2, 'WEBCHAT', 'B', 'ACTIVE', 'pk_b'), ($3, 'WHATSAPP', 'W', 'ACTIVE', 'pk_w')`,
      [siteA, siteB, whatsapp],
    );
    const [onA, viaToken, onBoth, noChat, done] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await q(`INSERT INTO customers (id) VALUES ($1), ($2), ($3), ($4), ($5)`, [onA, viaToken, onBoth, noChat, done]);
    const ident = (customer: string, kind: string, value: string) => q(`INSERT INTO customer_identities (id, customer_id, kind, value) VALUES ($1, $2, $3, $4)`, [uuidv7(), customer, kind, value]);
    await ident(onA, 'webchat_customer_ref', 'cust-1');
    await ident(onA, 'webchat_visitor', 'v_visitor_0001');
    await ident(viaToken, 'webchat_customer_ref', 'cust-2');
    await ident(onBoth, 'webchat_customer_ref', 'cust-3');
    await ident(noChat, 'webchat_customer_ref', 'cust-4');
    await ident(done, 'webchat_customer_ref', `${siteA}:cust-5`);
    const conv = (customer: string, channel: string) =>
      q(`INSERT INTO conversations (id, customer_id, channel_id, type, control_state) VALUES ($1, $2, $3, 'SUPPORT', 'ROUTING')`, [uuidv7(), customer, channel]);
    await conv(onA, siteA);
    await conv(onA, whatsapp); // other kinds do not count
    await q(`INSERT INTO webchat_user_tokens (id, channel_id, customer_id, token_ciphertext, expires_at) VALUES ($1, $2, $3, 'x', now() + interval '1 hour')`, [uuidv7(), siteB, viaToken]);
    await conv(onBoth, siteA);
    await conv(onBoth, siteB);
    await conv(done, siteA);

    const result = await runMigrations(database.pool, MIGRATIONS_DIR);
    expect(result.applied).toContain(SCOPE);
    const { rows } = await q(`SELECT customer_id, kind, value FROM customer_identities`);
    const valueOf = (customer: string, kind = 'webchat_customer_ref') => rows.find((r) => r.customer_id === customer && r.kind === kind)?.value;
    expect(valueOf(onA)).toBe(`${siteA}:cust-1`);
    expect(valueOf(onA, 'webchat_visitor')).toBe('v_visitor_0001');
    expect(valueOf(viaToken)).toBe(`${siteB}:cust-2`);
    expect(valueOf(onBoth)).toBe('cust-3');
    expect(valueOf(noChat)).toBe('cust-4');
    expect(valueOf(done)).toBe(`${siteA}:cust-5`);
  });
});
