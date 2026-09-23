import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { PgQueue, type HandlerResult, type QueueSubscription } from '../src/index.js';

let t: TestDatabase;
const subs: QueueSubscription[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await Promise.all(subs.map((s) => s.stop()));
  await t?.drop();
});
beforeEach(async () => {
  await Promise.all(subs.splice(0).map((s) => s.stop()));
  await t.pool.query('DELETE FROM jobs; DELETE FROM conversation_leases;');
});

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('PgQueue', () => {
  it('delivers each message exactly once across concurrent consumers', async () => {
    const seen: string[] = [];
    const producer = new PgQueue(t.pool, { workerId: 'p' });
    for (let i = 0; i < 60; i++) await producer.publish('conversation.turn', { i });
    for (const w of ['w1', 'w2', 'w3']) {
      const q = new PgQueue(t.pool, { workerId: w });
      subs.push(
        q.consume<{ i: number }>(
          'conversation.turn',
          async (m) => {
            seen.push(String(m.payload.i));
            await new Promise((r) => setTimeout(r, 2));
            return { kind: 'ack' };
          },
          { concurrency: 4, visibilityTimeoutSeconds: 30, maxAttempts: 3, pollIntervalMs: 10 },
        ),
      );
    }
    await waitFor(() => seen.length >= 60);
    expect(new Set(seen).size).toBe(60);
    expect(seen.length).toBe(60);
    const stats = await producer.stats('conversation.turn');
    expect(stats.depth).toBe(0);
  });

  it('drops duplicate publishes while a message with the same dedupe key is pending', async () => {
    const q = new PgQueue(t.pool, { workerId: 'w' });
    await q.publish('conversation.turn', { a: 1 }, { dedupeKey: 'interaction-1' });
    await q.publish('conversation.turn', { a: 2 }, { dedupeKey: 'interaction-1' });
    expect((await q.stats('conversation.turn')).depth).toBe(1);
  });

  it('retries failures and dead-letters after maxAttempts', async () => {
    const q = new PgQueue(t.pool, { workerId: 'w' });
    await q.publish('channel.deliver', { x: 1 });
    let attempts = 0;
    subs.push(
      q.consume(
        'channel.deliver',
        async (): Promise<HandlerResult> => {
          attempts++;
          return { kind: 'retry', delaySeconds: 0, reason: 'provider 503' };
        },
        { concurrency: 1, visibilityTimeoutSeconds: 30, maxAttempts: 3, pollIntervalMs: 10 },
      ),
    );
    await waitFor(async () => (await q.stats('channel.deliver')).dead === 1);
    expect(attempts).toBe(3);
    const { rows } = await t.pool.query(`SELECT last_error FROM jobs WHERE status = 'dead'`);
    expect(rows[0].last_error).toBe('provider 503');
  });

  it('defer does not consume an attempt', async () => {
    const q = new PgQueue(t.pool, { workerId: 'w' });
    await q.publish('conversation.turn', {});
    let calls = 0;
    subs.push(
      q.consume(
        'conversation.turn',
        async (m): Promise<HandlerResult> => {
          calls++;
          expect(m.attempt).toBe(1);
          return calls < 3 ? { kind: 'defer', delaySeconds: 0 } : { kind: 'ack' };
        },
        { concurrency: 1, visibilityTimeoutSeconds: 30, maxAttempts: 1, pollIntervalMs: 10 },
      ),
    );
    await waitFor(() => calls >= 3);
  });

  it('redelivers messages whose visibility timeout expired (crashed worker)', async () => {
    const q = new PgQueue(t.pool, { workerId: 'dead-worker' });
    await q.publish('conversation.turn', { crash: true });
    await t.pool.query(
      `UPDATE jobs SET status = 'running', locked_by = 'dead-worker', attempts = 1, locked_until = now() - interval '1 second'`,
    );
    const survivor = new PgQueue(t.pool, { workerId: 'survivor' });
    let got = 0;
    subs.push(
      survivor.consume(
        'conversation.turn',
        async (m) => {
          got = m.attempt;
          return { kind: 'ack' };
        },
        { concurrency: 1, visibilityTimeoutSeconds: 30, maxAttempts: 5, pollIntervalMs: 10 },
      ),
    );
    await waitFor(() => got > 0);
    expect(got).toBe(2);
  });

  it('with affinity, skips conversations busy on another live worker', async () => {
    const conv = '00000000-0000-7000-8000-000000000001';
    await t.pool.query(
      `INSERT INTO conversation_leases (conversation_id, worker_id, lease_version, busy, expires_at) VALUES ($1, 'other', 1, true, now() + interval '1 minute')`,
      [conv],
    );
    const q = new PgQueue(t.pool, { workerId: 'me', conversationAffinityTopics: ['conversation.turn'] });
    await q.publish('conversation.turn', {}, { groupKey: conv });
    let handled = false;
    subs.push(
      q.consume(
        'conversation.turn',
        async () => {
          handled = true;
          return { kind: 'ack' };
        },
        { concurrency: 1, visibilityTimeoutSeconds: 30, maxAttempts: 3, pollIntervalMs: 10 },
      ),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(handled).toBe(false);
    await t.pool.query(`UPDATE conversation_leases SET busy = false`);
    await waitFor(() => handled);
  });
});
