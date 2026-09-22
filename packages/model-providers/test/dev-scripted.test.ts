import type { ToolSpec } from '@ocso/domain';
import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelResult } from '../src/contract/types.js';
import { devScriptedProvider } from '../src/providers/dev-scripted/definition.js';
import { plausibleArgs } from '../src/providers/dev-scripted/args.js';
import { captureError } from './contract/provider-contract.js';
import { collect, media, runtimeConfig, standardRequest } from './support/requests.js';

const tool = (name: string, properties: Record<string, unknown>, required: string[]): ToolSpec => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties, required },
});

const TOOLS: ToolSpec[] = [
  tool('ocso__request_handoff', { reason: { type: 'string' }, priority: { type: 'string', enum: ['NORMAL', 'HIGH'] } }, ['reason']),
  tool('core_banking__get_balance', { accountId: { type: 'string' } }, ['accountId']),
  tool('core_banking__list_transactions', { accountId: { type: 'string' }, limit: { type: 'integer' } }, ['accountId']),
  tool('payments__create_refund', { amount: { type: 'number' }, orderId: { type: 'string' }, reason: { type: 'string' } }, ['amount', 'orderId']),
];

function adapter(settings: Record<string, unknown> = {}) {
  return devScriptedProvider.create(runtimeConfig('DEV_SCRIPTED', { latencyMs: 0, chunkDelayMs: 0, ...settings }, {}), { media });
}

const ask = (text: string, over: Partial<ModelRequest> = {}): ModelRequest =>
  standardRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    tools: TOOLS,
    ...over,
  });

async function finish(req: ModelRequest, a = adapter()): Promise<ModelResult> {
  const events = await collect(a.stream(req, 'scripted-1'));
  const last = events.at(-1);
  if (last?.type !== 'finish') throw new Error('no finish');
  return last.result;
}

describe('DEV_SCRIPTED provider (development only)', () => {
  it('is labelled development-only and declares simulated explicit caching', () => {
    expect(devScriptedProvider.devOnly).toBe(true);
    expect(devScriptedProvider.label).toMatch(/development only/i);
  });

  it('echoes ordinary messages as a streamed, clearly-labelled reply', async () => {
    const events = await collect(adapter().stream(ask('Hello, what are your hours?'), 'scripted-1'));
    expect(events.filter((e) => e.type === 'text-delta').length).toBeGreaterThan(3);
    const last = events.at(-1);
    if (last?.type !== 'finish') throw new Error('no finish');
    expect(last.result.finishReason).toBe('stop');
    expect(last.result.text).toContain('You said: "Hello, what are your hours?"');
    expect(last.result.text).toMatch(/development scripted model/);
    expect(last.result.identity.requestId).toMatch(/^dev-prov-dev_scripted-\d{6}$/);
  });

  it('requests a handoff when the customer asks for a human', async () => {
    const result = await finish(ask('This is useless, get me a human'));
    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('ocso__request_handoff');
    expect(result.toolCalls[0]?.input).toMatchObject({ reason: expect.stringContaining('get me a human') as unknown });
    expect(result.text).toMatch(/colleague/);
  });

  it('treats "agent please" as a handoff request too', async () => {
    const result = await finish(ask('agent please'));
    expect(result.toolCalls[0]?.toolName).toBe('ocso__request_handoff');
  });

  it('calls the matching tool with plausible arguments for balance / transactions / refund', async () => {
    const balance = await finish(ask('What is the balance on account 44556677?'));
    expect(balance.toolCalls[0]).toMatchObject({ toolName: 'core_banking__get_balance', input: { accountId: '44556677' } });

    const txns = await finish(ask('show my recent transactions'));
    expect(txns.toolCalls[0]).toMatchObject({ toolName: 'core_banking__list_transactions', input: { accountId: 'primary' } });

    const refund = await finish(ask('Please refund ₹1,250 for order A1B2C3, it arrived broken'));
    expect(refund.toolCalls[0]).toMatchObject({
      toolName: 'payments__create_refund',
      input: { amount: 1250, orderId: 'A1B2C3', reason: expect.stringContaining('arrived broken') as unknown },
    });
  });

  it('summarizes tool results once they are in the conversation (no further tool calls)', async () => {
    const req = ask('What is my balance?');
    const result = await finish({
      ...req,
      messages: [
        ...req.messages,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'core_banking__get_balance', input: { accountId: 'primary' } }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'core_banking__get_balance',
              output: { type: 'json', value: { available_balance: 5230.5, currency: 'INR', holds: [1, 2] } },
            },
          ],
        },
      ],
    });
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toContain('get balance: available balance: 5230.5, currency: INR, 2 holds');
  });

  it('answers in text when a keyword has no matching tool', async () => {
    const result = await finish(ask('what is my balance', { tools: [] }));
    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('You said');
  });

  it('simulates prompt-cache writes then reads for a repeated prefix; nothing when caching is OFF', async () => {
    const a = adapter();
    const first = await finish(standardRequest({ tools: TOOLS }), a);
    expect(first.usage.cacheWriteTokens).toBeGreaterThan(0);
    expect(first.usage.cachedInputTokens).toBe(0);
    const second = await finish(standardRequest({ tools: TOOLS }), a);
    expect(second.usage.cachedInputTokens).toBe(first.usage.cacheWriteTokens);
    expect(second.usage.cacheWriteTokens).toBe(0);
    expect(second.usage.inputTokens).toBe(first.usage.inputTokens);

    const off = await finish(standardRequest({ tools: TOOLS, cache: { policy: 'OFF' } }), a);
    expect(off.usage.cachedInputTokens).toBe(0);
    expect(off.usage.cacheWriteTokens).toBe(0);
    expect(off.usage.uncachedInputTokens).toBe(off.usage.inputTokens);
  });

  it('honours configured latency as TTFT', async () => {
    const result = await finish(ask('hi'), adapter({ latencyMs: 60, chunkDelayMs: 1 }));
    expect(result.ttftMs).toBeGreaterThanOrEqual(50);
    expect(result.latencyMs).toBeGreaterThanOrEqual(result.ttftMs ?? 0);
  });

  it('supports generate() through the same core path', async () => {
    const result = await adapter().generate(ask('check my balance'), 'scripted-1');
    expect(result.toolCalls[0]?.toolName).toBe('core_banking__get_balance');
    expect(result.ttftMs).toBeNull();
  });

  it.each([
    ['RATE_LIMITED', 'provider_rate_limited'],
    ['UNAVAILABLE', 'provider_unavailable'],
  ])('simulateError %s surfaces as %s (demo retries/fallback)', async (simulateError, category) => {
    const a = adapter({ simulateError });
    const error = await captureError(() => collect(a.stream(ask('hi'), 'scripted-1')));
    expect(error.category).toBe(category);
    await expect(a.health()).resolves.toMatchObject({ status: category === 'provider_rate_limited' ? 'DEGRADED' : 'DOWN' });
  });

  it('stops promptly when the caller aborts during simulated latency', async () => {
    const controller = new AbortController();
    const a = adapter({ latencyMs: 5_000 });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const error = await captureError(() => collect(a.stream(ask('hi', { abortSignal: controller.signal }), 'scripted-1')));
    expect(error.code).toBe('model_request_cancelled');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('health() is OK by default', async () => {
    await expect(adapter().health()).resolves.toMatchObject({ status: 'OK' });
  });
});

describe('plausibleArgs', () => {
  it('fills required fields from schema types and the text, deterministically', () => {
    const schema = {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        currency: { type: 'string' },
        count: { type: 'integer' },
        confirm: { type: 'boolean' },
        mode: { type: 'string', enum: ['FULL', 'PARTIAL'] },
        tags: { type: 'array' },
        reason: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['amount', 'currency', 'count', 'confirm', 'mode', 'tags'],
    };
    const args = plausibleArgs(schema, 'partial refund of 99.5 please');
    // Optional `reason` is inferable from the text; optional `note` is left out.
    expect(args).toEqual({ amount: 99.5, currency: 'INR', count: 5, confirm: false, mode: 'PARTIAL', tags: [], reason: 'partial refund of 99.5 please' });
    expect(plausibleArgs(schema, 'partial refund of 99.5 please')).toEqual(args);
  });
});
