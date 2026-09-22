import { describe, expect, it } from 'vitest';
import { sarvamProvider } from '../../src/providers/sarvam/definition.js';
import { collect, runtimeConfig, standardRequest } from '../support/requests.js';
import {
  CHAT_EXPECTED_USAGE,
  CHAT_TEXT,
  CHAT_TOOL_CALL,
  chatError,
  chatJson,
  chatStream,
  chatTools,
  chatUsage,
} from './fixtures/chat-completions-format.js';
import { describeProviderContract, harness, type ContractFixture } from './provider-contract.js';

const API_KEY = 'sarvam-sub-key-SECRET-5566778899';

const fixture: ContractFixture = {
  name: 'Sarvam (OpenAI-compatible)',
  definition: sarvamProvider,
  config: runtimeConfig('SARVAM', {}, { apiKey: API_KEY }),
  model: 'sarvam-105b',
  secrets: [API_KEY],
  streamResponse: () => chatStream('sarvam-105b', { 'x-request-id': 'sarvam-req-stream' }),
  generateResponse: () => chatJson('sarvam-105b'),
  errorResponse: (status, echo) => chatError(status, echo),
  tools: chatTools,
  expected: {
    streamText: CHAT_TEXT,
    toolCall: CHAT_TOOL_CALL,
    streamUsage: CHAT_EXPECTED_USAGE,
    generateUsage: CHAT_EXPECTED_USAGE,
    streamRequestId: 'sarvam-req-stream',
    // No request-id header: falls back to the body id.
    generateRequestId: 'chatcmpl-generate-1',
    region: null,
    // Sarvam documents no cache controls (ADR-006): never send any.
    prefixCacheDirectives: 0,
  },
};

describeProviderContract(fixture);

describe('Sarvam specifics', () => {
  it('posts to api.sarvam.ai/v1 with both auth headers and asks for streamed usage', async () => {
    const h = harness(fixture, () => fixture.streamResponse());
    await collect(h.adapter.stream(standardRequest(), 'sarvam-105b'));
    const call = h.modelCalls[0];
    expect(call?.url).toBe('https://api.sarvam.ai/v1/chat/completions');
    expect(call?.headers['api-subscription-key']).toBe(API_KEY);
    expect(call?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect((call?.body as Record<string, unknown>)['stream_options']).toEqual({ include_usage: true });
  });

  it.each([
    ['none', null],
    ['low', 'low'],
    ['medium', undefined],
    ['high', 'high'],
  ] as const)('maps reasoning %s to reasoning_effort %s', async (reasoning, expected) => {
    const h = harness(fixture, () => fixture.generateResponse());
    await h.adapter.generate(standardRequest({ reasoning }), 'sarvam-105b');
    const body = h.modelCalls[0]?.body as Record<string, unknown>;
    if (expected === undefined) expect('reasoning_effort' in body).toBe(false);
    else expect(body['reasoning_effort']).toBe(expected);
  });

  it('maps cached_tokens when Sarvam reports them (UNVERIFIED live)', async () => {
    const h = harness(fixture, () => chatStream('sarvam-105b', {}, chatUsage({ cachedTokens: 96 })));
    const events = await collect(h.adapter.stream(standardRequest(), 'sarvam-105b'));
    const finish = events.at(-1);
    expect(finish?.type === 'finish' && finish.result.usage.cachedInputTokens).toBe(96);
    expect(sarvamProvider.capabilities('sarvam-105b', { baseURL: 'https://api.sarvam.ai/v1' }).promptCaching).toBe('UNVERIFIED');
  });

  it('health probe disables thinking so a 1-token budget is not consumed by reasoning', async () => {
    const h = harness(fixture, () => fixture.generateResponse());
    await expect(h.adapter.health()).resolves.toMatchObject({ status: 'OK' });
    const body = h.modelCalls[0]?.body as Record<string, unknown>;
    expect(body['model']).toBe('sarvam-105b');
    expect(body['reasoning_effort']).toBeNull();
  });
});
