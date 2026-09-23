import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpAdapterHost } from '@nestjs/core';
import type { Principal } from '@ocso/auth';
import { DelegationTokens } from '../../src/common/delegation.js';
import { CONFIRM_BOUND_MS, LoopbackCapabilityRunner, OUTCOME_UNKNOWN_CODE, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from '../../src/modules/internal-agent/loopback-runner.js';

/**
 * The loopback runner's bounds (final review: a 30 s abort marked a running write FAILED). Aborting the request
 * does not stop the in-process route, so a write gets a longer bound, and one that outlives it is answered as
 * "outcome unknown" (it may or may not have applied), never thrown as "could not be run". Reads still fail plainly.
 */

const principal = { userId: 'u1', sessionId: 's1' } as unknown as Principal;
const scope = { threadId: 't1', correlationId: 'c1', cardId: 'card1' };

/** An Express-like app whose routes answer after `delayMs`. */
function runnerWith(delayMs: number) {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const timer = setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method }));
    }, delayMs);
    res.on('close', () => clearTimeout(timer));
  };
  const host = { httpAdapter: { getInstance: () => handler } } as unknown as HttpAdapterHost;
  const runner = new LoopbackCapabilityRunner(host, new DelegationTokens());
  runner.readTimeoutMs = 100;
  runner.writeTimeoutMs = 300;
  return runner;
}

let runner: LoopbackCapabilityRunner | null = null;
afterEach(async () => {
  await runner?.onModuleDestroy();
  runner = null;
});

describe('loopback runner bounds', () => {
  it('writes wait longer than reads, above every UI budget for the same routes (copilot drafts: 60 s)', () => {
    expect(READ_TIMEOUT_MS).toBe(30_000);
    expect(WRITE_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(CONFIRM_BOUND_MS).toBe(READ_TIMEOUT_MS + WRITE_TIMEOUT_MS);
  });

  it('a write slower than the read bound still finishes and answers', async () => {
    runner = runnerWith(200);
    const res = await runner.call(principal, scope, { method: 'PATCH', path: '/v1/agents/a1', body: { name: 'x' } });
    expect(res).toEqual({ status: 200, body: { ok: true, method: 'PATCH' } });
  });

  it('a write past its bound is "outcome unknown", not an error', async () => {
    runner = runnerWith(2_000);
    const res = await runner.call(principal, scope, { method: 'POST', path: '/v1/copilot/draft', body: {} });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: { code: OUTCOME_UNKNOWN_CODE, details: { outcome: 'UNKNOWN' } } });
    expect((res.body as { error: { message: string } }).error.message).toMatch(/may or may not have applied/);
  });

  it('a read past its bound fails plainly (nothing changed)', async () => {
    runner = runnerWith(2_000);
    await expect(runner.call(principal, scope, { method: 'GET', path: '/v1/agents' })).rejects.toThrow();
  });
});

describe('"What can you do?" with the writes kill switch off', async () => {
  const { readsOnlyUnless } = await import('../../src/modules/internal-agent/internal-agent.controller.js');
  const s = {
    suggestions: [
      { label: 'What needs my attention?', prompt: 'What needs my attention?', tool: 'insight.attention_summary' },
      { label: 'Pause a virtual agent', prompt: 'Pause a virtual agent', tool: 'agents.set_agent_status' },
    ],
    areas: [
      { area: 'agents', label: 'Virtual agents', reads: 3, writes: 4 },
      { area: 'webhooks', label: 'Webhooks', reads: 0, writes: 2 },
    ],
    total: 9,
  };

  it('on: unchanged, and says so', () => {
    expect(readsOnlyUnless(true, s)).toEqual({ ...s, writesOn: true });
  });

  it('off: reads only — no change chips, no change counts, areas with only changes dropped', () => {
    expect(readsOnlyUnless(false, s)).toEqual({
      suggestions: [s.suggestions[0]],
      areas: [{ area: 'agents', label: 'Virtual agents', reads: 3, writes: 0 }],
      total: 3,
      writesOn: false,
    });
  });
});
