import { describe, expect, it } from 'vitest';
import { bearerFetch } from '../../src/providers/foundry/entra.js';
import { foundryProvider } from '../../src/providers/foundry/definition.js';
import { foundryBaseUrls, foundrySettingsSchema } from '../../src/providers/foundry/settings.js';
import { fakeFetch, jsonResponse } from '../support/fake-fetch.js';
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
import { CHAT_EXPECTED_USAGE, CHAT_TEXT, CHAT_TOOL_CALL, chatError, chatJson, chatStream, chatTools } from './fixtures/chat-completions-format.js';
import {
  OPENAI_EXPECTED_USAGE,
  OPENAI_TEXT,
  OPENAI_TOOL_CALL,
  openAiError,
  responsesJson,
  responsesStream,
  responsesTools,
} from './fixtures/openai-format.js';
import { describeProviderContract, harness, type ContractFixture } from './provider-contract.js';

const API_KEY = 'foundry-key-SECRET-9f8e7d6c5b4a';
const settings = {
  resourceName: 'ocso-foundry',
  deployments: {
    'gpt-55-prod': { modelFamily: 'openai', model: 'gpt-5.5' },
    'claude-prod': { modelFamily: 'anthropic', model: 'claude-sonnet-4-6' },
    'deepseek-v4': { modelFamily: 'other' },
  },
};
const config = runtimeConfig('FOUNDRY', settings, { apiKey: API_KEY }, 'centralindia');
const azureHeaders = (id: string) => ({ 'apim-request-id': id, 'x-request-id': `x-${id}` });

const openaiFamily: ContractFixture = {
  name: 'Foundry OpenAI deployment (Responses)',
  definition: foundryProvider,
  config,
  model: 'gpt-55-prod',
  secrets: [API_KEY],
  streamResponse: () => responsesStream(azureHeaders('apim-stream-1'), 'gpt-5.5'),
  generateResponse: () => responsesJson(azureHeaders('apim-generate-1'), 'gpt-5.5'),
  errorResponse: (status, echo) => openAiError(status, echo, { 'apim-request-id': 'apim-err' }),
  tools: responsesTools,
  expected: {
    streamText: OPENAI_TEXT,
    toolCall: OPENAI_TOOL_CALL,
    streamUsage: OPENAI_EXPECTED_USAGE,
    generateUsage: OPENAI_EXPECTED_USAGE,
    streamRequestId: 'apim-stream-1',
    generateRequestId: 'apim-generate-1',
    region: 'centralindia',
    prefixCacheDirectives: 1,
  },
  assertPrefixPlacement: (body) => {
    const b = body as Record<string, unknown>;
    expect(b['prompt_cache_key']).toBe('agent-7:pv-3');
    expect(b['model']).toBe('gpt-55-prod');
    expect(b['store']).toBe(false);
  },
};

const claudeFamily: ContractFixture = {
  name: 'Foundry Claude deployment',
  definition: foundryProvider,
  config,
  model: 'claude-prod',
  secrets: [API_KEY],
  streamResponse: () => anthropicStream(azureHeaders('apim-claude-stream')),
  generateResponse: () => anthropicMessage(azureHeaders('apim-claude-generate')),
  errorResponse: anthropicError,
  tools: anthropicTools,
  expected: {
    streamText: ANTHROPIC_TEXT,
    toolCall: ANTHROPIC_TOOL_CALL,
    streamUsage: ANTHROPIC_EXPECTED_USAGE,
    generateUsage: ANTHROPIC_EXPECTED_USAGE,
    streamRequestId: 'apim-claude-stream',
    generateRequestId: 'apim-claude-generate',
    region: 'centralindia',
    prefixCacheDirectives: 3,
  },
  assertPrefixPlacement: (body) => anthropicPlacement(body),
};

const otherFamily: ContractFixture = {
  name: 'Foundry other deployment (Chat Completions)',
  definition: foundryProvider,
  config,
  model: 'deepseek-v4',
  secrets: [API_KEY],
  streamResponse: () => chatStream('DeepSeek-V4', azureHeaders('apim-other-stream')),
  generateResponse: () => chatJson('DeepSeek-V4', azureHeaders('apim-other-generate')),
  errorResponse: (status, echo) => chatError(status, echo),
  tools: chatTools,
  expected: {
    streamText: CHAT_TEXT,
    toolCall: CHAT_TOOL_CALL,
    streamUsage: CHAT_EXPECTED_USAGE,
    generateUsage: CHAT_EXPECTED_USAGE,
    streamRequestId: 'apim-other-stream',
    generateRequestId: 'apim-other-generate',
    region: 'centralindia',
    // Cache behaviour of non-OpenAI Foundry models is unverified: send nothing.
    prefixCacheDirectives: 0,
  },
};

describeProviderContract(openaiFamily);
describeProviderContract(claudeFamily);
describeProviderContract(otherFamily);

describe('Foundry specifics', () => {
  it('routes each deployment family to its Foundry surface with the api-key / x-api-key header', async () => {
    const h = harness(openaiFamily, (req) =>
      req.url.includes('/anthropic/') ? anthropicStream() : req.url.endsWith('/responses') ? responsesStream({}) : chatStream('x'),
    );
    for (const model of ['gpt-55-prod', 'claude-prod', 'deepseek-v4']) await collect(h.adapter.stream(standardRequest(), model));
    expect(h.modelCalls.map((c) => c.url)).toEqual([
      'https://ocso-foundry.services.ai.azure.com/openai/v1/responses',
      'https://ocso-foundry.services.ai.azure.com/anthropic/v1/messages',
      'https://ocso-foundry.services.ai.azure.com/openai/v1/chat/completions',
    ]);
    expect(h.modelCalls[0]?.headers['api-key']).toBe(API_KEY);
    expect(h.modelCalls[1]?.headers['x-api-key']).toBe(API_KEY);
    expect(h.modelCalls[2]?.headers['api-key']).toBe(API_KEY);
  });

  it('derives the Claude surface from the resource origin even for project endpoints', () => {
    const s = foundrySettingsSchema.parse({ endpoint: 'https://res1.services.ai.azure.com/api/projects/support/' });
    expect(foundryBaseUrls(s)).toEqual({
      openai: 'https://res1.services.ai.azure.com/api/projects/support/openai/v1',
      anthropic: 'https://res1.services.ai.azure.com/anthropic/v1',
    });
    expect(foundrySettingsSchema.safeParse({}).success).toBe(false);
  });

  it('uses chat completions + the openai options key for CHAT_COMPLETIONS deployments', async () => {
    const chatConfig = runtimeConfig(
      'FOUNDRY',
      { resourceName: 'ocso-foundry', deployments: { 'gpt41-chat': { modelFamily: 'openai', model: 'gpt-4.1', api: 'CHAT_COMPLETIONS' } } },
      { apiKey: API_KEY },
    );
    const h = harness({ ...openaiFamily, config: chatConfig }, () => chatStream('gpt-4.1'));
    await collect(h.adapter.stream(standardRequest(), 'gpt41-chat'));
    expect(h.modelCalls[0]?.url).toBe('https://ocso-foundry.services.ai.azure.com/openai/v1/chat/completions');
    expect((h.modelCalls[0]?.body as Record<string, unknown>)['prompt_cache_key']).toBe('agent-7:pv-3');
  });

  it('reports cached tokens from a non-OpenAI deployment only when the server sends them', async () => {
    const h = harness(otherFamily, () =>
      jsonResponse({
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 64 } },
      }),
    );
    const result = await h.adapter.generate(standardRequest(), 'deepseek-v4');
    expect(result.usage.cachedInputTokens).toBe(64);
  });

  it('Entra ID: bearerFetch swaps the static key header for a fresh bearer token per request', async () => {
    const ff = fakeFetch(() => jsonResponse({}));
    let n = 0;
    const f = bearerFetch(async () => `token-${++n}`, ff.fetch);
    await f('https://x/anthropic/v1/messages', { headers: { 'x-api-key': 'k', authorization: 'Bearer entra-id' } });
    await f('https://x/anthropic/v1/messages', { headers: {} });
    expect(ff.calls.map((c) => c.headers['authorization'])).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(ff.calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('Entra ID mode builds adapters without an API key; API key mode requires one', () => {
    const entra = runtimeConfig('FOUNDRY', { ...settings, authMode: 'ENTRA_ID' }, {});
    expect(() => foundryProvider.create(entra, { media })).not.toThrow();
    const missing = runtimeConfig('FOUNDRY', settings, {});
    expect(() => foundryProvider.create(missing, { media })).toThrow(/API key/);
  });
});
