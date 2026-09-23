import { describe, expect, it } from 'vitest';
import { anthropicProvider } from '../../src/providers/anthropic/definition.js';
import { fakeFetch, sseResponse } from '../support/fake-fetch.js';
import { collect, media, runtimeConfig, standardRequest } from '../support/requests.js';
import {
  ANTHROPIC_EXPECTED_USAGE,
  ANTHROPIC_TEXT,
  ANTHROPIC_TOOL_CALL,
  anthropicError,
  anthropicMessage,
  anthropicPlacement,
  anthropicStream,
  anthropicTools,
} from './fixtures/anthropic-format.js';
import { captureError, describeProviderContract, harness, type ContractFixture } from './provider-contract.js';

const API_KEY = 'sk-ant-test-SECRET-0123456789';

const fixture: ContractFixture = {
  name: 'Anthropic',
  definition: anthropicProvider,
  config: runtimeConfig('ANTHROPIC', {}, { apiKey: API_KEY }),
  model: 'claude-sonnet-4-6',
  secrets: [API_KEY],
  streamResponse: () => anthropicStream({ 'request-id': 'req_anth_stream' }),
  generateResponse: () => anthropicMessage({ 'request-id': 'req_anth_generate' }),
  errorResponse: anthropicError,
  tools: anthropicTools,
  expected: {
    streamText: ANTHROPIC_TEXT,
    toolCall: ANTHROPIC_TOOL_CALL,
    streamUsage: ANTHROPIC_EXPECTED_USAGE,
    generateUsage: ANTHROPIC_EXPECTED_USAGE,
    streamRequestId: 'req_anth_stream',
    generateRequestId: 'req_anth_generate',
    region: null,
    prefixCacheDirectives: 3,
  },
  assertPrefixPlacement: (body) => anthropicPlacement(body),
};

describeProviderContract(fixture);

describe('Anthropic specifics', () => {
  it('calls the Messages API with x-api-key and a model instance id', async () => {
    const h = harness(fixture, () => fixture.streamResponse());
    await collect(h.adapter.stream(standardRequest(), fixture.model));
    const call = h.modelCalls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.headers['x-api-key']).toBe(API_KEY);
    expect((call?.body as { model: string }).model).toBe('claude-sonnet-4-6');
  });

  it('applies the 1h TTL to every breakpoint when requested', async () => {
    const h = harness(fixture, () => fixture.streamResponse());
    await collect(h.adapter.stream(standardRequest({ cache: { policy: 'PREFIX', ttl: '1h' } }), fixture.model));
    anthropicPlacement(h.modelCalls[0]?.body, '1h');
  });

  it('never exceeds 4 breakpoints: keeps the first three and the last', async () => {
    const req = standardRequest();
    const many = Array.from({ length: 6 }, (_, i) => [
      { role: 'user' as const, content: [{ type: 'text' as const, text: `q${i}` }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: `a${i}` }], breakpointAfter: 'HISTORY' as const },
    ]).flat();
    const h = harness(fixture, () => fixture.streamResponse());
    await collect(h.adapter.stream({ ...req, messages: [...many, { role: 'user', content: [{ type: 'text', text: 'now' }] }] }, fixture.model));
    const body = h.modelCalls[0]?.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> };
    const marked = body.messages.map((m, i) => (m.content.some((p) => p.cache_control) ? i : -1)).filter((i) => i >= 0);
    expect(marked).toEqual([1, 11]);
  });

  it('maps a mid-stream SSE error after partial text (fallback must then be refused by policy)', async () => {
    const h = harness(fixture, () =>
      sseResponse([
        { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
        { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: `Overloaded ${API_KEY}` } } },
      ]),
    );
    const seen: string[] = [];
    const error = await captureError(async () => {
      for await (const e of h.adapter.stream(standardRequest(), fixture.model)) seen.push(e.type);
    });
    expect(seen).toEqual(['text-delta']);
    expect(error).toMatchObject({ category: 'provider_unavailable', code: 'provider_overloaded', details: { providerErrorCode: 'overloaded_error' } });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('aborts the provider request when the consumer stops iterating early', async () => {
    let signal: AbortSignal | undefined;
    const ff = fakeFetch(() => fixture.streamResponse());
    const spy: typeof fetch = (input, init) => {
      signal = init?.signal ?? undefined;
      return ff.fetch(input, init);
    };
    const adapter = anthropicProvider.create(fixture.config, { media, fetch: spy });
    for await (const e of adapter.stream(standardRequest(), fixture.model)) if (e.type === 'text-delta') break;
    expect(signal?.aborted).toBe(true);
  });
});
