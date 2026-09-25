import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { uuidv7 } from '@ocso/db';
import { lostWorkerTimeoutSeconds, reapLostWorkers } from '../src/index.js';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe('lost worker recovery (docs/archive/specs/10 §9)', () => {
  it('marks silent workers LOST and hands their running jobs back immediately', async () => {
    await t.pool.query(`INSERT INTO workers (id, hostname, version, status, capacity, heartbeat_at) VALUES
      ('w-dead', 'h1', 'v', 'HEALTHY', 10, now() - interval '60 seconds'),
      ('w-alive', 'h2', 'v', 'HEALTHY', 10, now())`);
    const dead = uuidv7();
    const alive = uuidv7();
    await t.pool.query(
      `INSERT INTO jobs (id, topic, payload, status, attempts, locked_by, locked_until) VALUES
        ($1, 'conversation.turn', '{}', 'running', 1, 'w-dead', now() + interval '2 minutes'),
        ($2, 'conversation.turn', '{}', 'running', 1, 'w-alive', now() + interval '2 minutes')`,
      [dead, alive],
    );
    expect(await reapLostWorkers(t.db, 15)).toBe(1);
    const { rows } = await t.db.execute<{ id: string; status: string; locked_by: string | null }>(sql`SELECT id, status, locked_by FROM jobs ORDER BY locked_by NULLS FIRST`);
    expect(rows).toEqual([
      { id: dead, status: 'queued', locked_by: null },
      { id: alive, status: 'running', locked_by: 'w-alive' },
    ]);
    const workers = await t.db.execute<{ id: string; status: string }>(sql`SELECT id, status FROM workers ORDER BY id`);
    expect(workers.rows).toEqual([
      { id: 'w-alive', status: 'HEALTHY' },
      { id: 'w-dead', status: 'LOST' },
    ]);
  });

  it('declares a worker lost after three missed heartbeats, never under 15 s', () => {
    expect(lostWorkerTimeoutSeconds(3)).toBe(15);
    expect(lostWorkerTimeoutSeconds(10)).toBe(30);
  });
});
