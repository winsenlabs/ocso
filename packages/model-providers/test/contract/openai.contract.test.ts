import { describe, expect, it } from 'vitest';
import { openAiProvider } from '../../src/providers/openai/definition.js';
import { collect, countKeys, CACHE_DIRECTIVE_KEYS, runtimeConfig, standardRequest } from '../support/requests.js';
import {
  OPENAI_EXPECTED_USAGE,
  OPENAI_TEXT,
  OPENAI_TOOL_CALL,
  openAiError,
  responsesJson,
  responsesStream,
  responsesTools,
  responsesUsage,
} from './fixtures/openai-format.js';
import { describeProviderContract, harness, type ContractFixture } from './provider-contract.js';

const API_KEY = 'sk-proj-test-SECRET-abcdef123456';

const fixture: ContractFixture = {
  name: 'OpenAI (Responses API)',
  definition: openAiProvider,
  config: runtimeConfig('OPENAI', {}, { apiKey: API_KEY }),
  model: 'gpt-5.5',
  secrets: [API_KEY],
  streamResponse: () => responsesStream({ 'x-request-id': 'req_oai_stream' }),
  generateResponse: () => responsesJson({ 'x-request-id': 'req_oai_generate' }),
  errorResponse: (status, echo) => openAiError(status, echo),
  tools: responsesTools,
  expected: {
    streamText: OPENAI_TEXT,
    toolCall: OPENAI_TOOL_CALL,
    streamUsage: OPENAI_EXPECTED_USAGE,
    generateUsage: OPENAI_EXPECTED_USAGE,
    streamRequestId: 'req_oai_stream',
    generateRequestId: 'req_oai_generate',
    region: null,
    // Automatic caching: only the routing key is sent.
    prefixCacheDirectives: 1,
  },
  assertPrefixPlacement: (body) => {
    const b = body as Record<string, unknown>;
    expect(b['prompt_cache_key']).toBe('agent-7:pv-3');
    expect(b['prompt_cache_retention']).toBeUndefined();
    expect(b['store']).toBe(false);
  },
};

describeProviderContract(fixture);

describe('OpenAI specifics', () => {
  it('calls /v1/responses with a bearer key, sends instructions as system/developer input items', async () => {
    const h = harness(fixture, () => fixture.streamResponse());
    await collect(h.adapter.stream(standardRequest(), 'gpt-5.5'));
    const call = h.modelCalls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/responses');
    expect(call?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    const input = (call?.body as { input: Array<{ role: string }> }).input;
    expect(input.slice(0, 3).map((i) => i.role)).toEqual(['developer', 'developer', 'developer']);
  });

  it('asks for 24h retention before GPT-5.6 when the request wants the long TTL', async () => {
    const h = harness(fixture, () => fixture.streamResponse());
    await collect(h.adapter.stream(standardRequest({ cache: { policy: 'PREFIX', key: 'k1', ttl: '1h' } }), 'gpt-5.5'));
    expect((h.modelCalls[0]?.body as Record<string, unknown>)['prompt_cache_retention']).toBe('24h');
  });

  it('uses explicit breakpoints + prompt_cache_options on GPT-5.6 and reports cache writes', async () => {
    const usage = responsesUsage({ cacheWriteTokens: 300 });
    const h = harness(fixture, () => responsesStream({ 'x-request-id': 'r' }, 'gpt-5.6', usage));
    const events = await collect(h.adapter.stream(standardRequest(), 'gpt-5.6'));
    const body = h.modelCalls[0]?.body as Record<string, unknown>;
    expect(body['prompt_cache_options']).toEqual({ mode: 'implicit' });
    // Both system breakpoints are sent; the Responses API has no breakpoint slot on assistant
    // output text, so the HISTORY marker is dropped there and implicit mode covers the tail.
    expect(countKeys(body, new Set(['prompt_cache_breakpoint']))).toBe(2);
    expect(countKeys(body, CACHE_DIRECTIVE_KEYS)).toBe(4);
    const finish = events.at(-1);
    expect(finish?.type === 'finish' && finish.result.usage.cacheWriteTokens).toBe(300);
    expect(openAiProvider.capabilities('gpt-5.6', { storeResponses: false }).reportsCacheWrites).toBe(true);
  });

  it('keeps responses stored only when the admin opts in', async () => {
    const stored = { ...fixture, config: runtimeConfig('OPENAI', { storeResponses: true }, { apiKey: API_KEY }) };
    const h = harness(stored, () => fixture.streamResponse());
    await collect(h.adapter.stream(standardRequest(), 'gpt-5.5'));
    expect((h.modelCalls[0]?.body as Record<string, unknown>)['store']).toBe(true);
  });

  it('maps insufficient_quota to provider_rate_limited/provider_quota_exhausted', async () => {
    const h = harness(fixture, () =>
      new Response(JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(h.adapter.generate(standardRequest(), 'gpt-5.5')).rejects.toMatchObject({
      category: 'provider_rate_limited',
      code: 'provider_quota_exhausted',
    });
  });
});
