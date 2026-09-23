import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type Database } from '../src/client.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

let t: TestDatabase;
let d: Database;
const errors: Error[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  d = createDatabase({ connectionString: t.url, maxConnections: 2, applicationName: 'ocso-pool-test', onError: (e) => errors.push(e) });
});
afterAll(async () => {
  await d?.close();
  await t?.drop();
});

describe('database pool resilience', () => {
  it('survives the server terminating idle connections and reconnects on the next query', async () => {
    await d.db.execute(sql`SELECT 1`);
    await t.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ocso-pool-test' AND pid <> pg_backend_pid()`);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.some((e) => (e as { code?: string }).code === '57P01')).toBe(true);
    const { rows } = await d.db.execute<{ ok: number }>(sql`SELECT 1 AS ok`);
    expect(rows[0]!.ok).toBe(1);
  });
});
