import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditEvents, promptVersions, virtualAgents } from '../src/schema/index.js';
import { runMigrations } from '../src/migrate.js';
import { uuidv7 } from '../src/ids.js';
import { MIGRATIONS_DIR, createTestDatabase, type TestDatabase } from '../src/testing.js';

let t: TestDatabase;

/** Drizzle wraps driver errors; assert on the root Postgres error. */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the query to fail').not.toBeNull();
  let cursor: unknown = err;
  const messages: string[] = [];
  while (cursor instanceof Error) {
    messages.push(cursor.message);
    cursor = (cursor as Error & { cause?: unknown }).cause;
  }
  expect(messages.join(' | ')).toMatch(pattern);
}

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe('migrations', () => {
  it('are idempotent on re-run', async () => {
    const again = await runMigrations(t.pool, MIGRATIONS_DIR);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThanOrEqual(2);
  });

  it('create singleton settings rows', async () => {
    const { rows } = await t.pool.query('SELECT (SELECT count(*) FROM deployment_settings) AS d, (SELECT count(*) FROM worker_settings) AS w');
    expect(rows[0]).toEqual({ d: '1', w: '1' });
  });

  it('reject invalid worker settings at the database level', async () => {
    await expect(t.pool.query('UPDATE worker_settings SET min_warm_workers = 20, max_workers = 10')).rejects.toThrow(/worker_settings_bounds_ck/);
  });
});

describe('audit immutability', () => {
  it('rejects UPDATE, DELETE and TRUNCATE on audit_events', async () => {
    const id = uuidv7();
    await t.db.insert(auditEvents).values({ id, actorType: 'SYSTEM', via: 'SYSTEM', action: 'test', targetType: 'x', summary: 's' });
    await rejectsWith(t.db.execute(sql`UPDATE audit_events SET summary = 'changed' WHERE id = ${id}`), /append-only/);
    await rejectsWith(t.db.execute(sql`DELETE FROM audit_events WHERE id = ${id}`), /append-only/);
    await rejectsWith(t.db.execute(sql`TRUNCATE audit_events`), /append-only/);
  });
});

describe('prompt version immutability', () => {
  it('allows the activation stamp but not content changes', async () => {
    const agentId = uuidv7();
    await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: `maya-${agentId}`, conversationType: 'SUPPORT' });
    const id = uuidv7();
    await t.db.insert(promptVersions).values({
      id, agentId, version: 1, components: { identity: 'a' }, componentHashes: {}, promptHash: 'pc_1',
      runtimeContractVersion: 'v', changedComponents: ['identity'], reason: 'init',
    });
    await t.db.execute(sql`UPDATE prompt_versions SET first_activated_at = now() WHERE id = ${id}`);
    await rejectsWith(t.db.execute(sql`UPDATE prompt_versions SET components = '{"identity":"b"}' WHERE id = ${id}`), /immutable/);
    await rejectsWith(t.db.execute(sql`DELETE FROM prompt_versions WHERE id = ${id}`), /immutable/);
  });
});

describe('uuidv7', () => {
  it('is time ordered and RFC formatted', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
