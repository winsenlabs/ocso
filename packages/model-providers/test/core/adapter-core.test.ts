import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { ModelCapabilities } from '../../src/contract/types.js';
import { createAiSdkAdapter } from '../../src/core/adapter.js';
import type { AiSdkAdapterSpec } from '../../src/core/spec.js';
import { collect, media, standardRequest } from '../support/requests.js';

const caps = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  imageInput: false,
  fileInput: false,
  audioInput: false,
  toolCalling: true,
  structuredOutput: true,
  reasoning: true,
  streaming: true,
  promptCaching: 'EXPLICIT',
  reportsCacheWrites: true,
  ...over,
});

const generateResult = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: undefined } },
  response: { id: 'resp_1', modelId: 'm' },
  warnings: [{ type: 'unsupported', feature: 'temperature' }],
});

function spec(model: MockLanguageModelV4, over: Partial<AiSdkAdapterSpec> = {}): AiSdkAdapterSpec {
  return {
    kind: 'OPENAI',
    providerId: 'p1',
    region: null,
    media,
    capabilities: () => caps(),
    languageModel: () => model,
    providerOptions: () => ({ request: { mock: { cacheKey: 'k' } }, breakpoint: (kind) => ({ mock: { bp: kind } }) }),
    requestIdHeaders: [],
    healthModel: 'm',
    secrets: [],
    ...over,
  };
}

describe('shared AI-SDK core', () => {
  it('passes toolOrder-sorted schema-only tools, request provider options, reasoning, and markers', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('ok') });
    const adapter = createAiSdkAdapter(spec(model));
    const result = await adapter.generate(standardRequest({ reasoning: 'low' }), 'm');
    const call = model.doGenerateCalls[0];
    expect(call?.tools?.map((t) => t.name)).toEqual(['alpha_ping', 'core__get_balance', 'zeta_lookup']);
    expect(call?.providerOptions).toEqual({ mock: { cacheKey: 'k' } });
    expect(call?.reasoning).toBe('low');
    expect(call?.maxOutputTokens).toBe(512);
    expect(call?.temperature).toBe(0.2);
    expect(call?.toolChoice).toEqual({ type: 'auto' });
    const system = call?.prompt.filter((m) => m.role === 'system');
    expect(system?.map((m) => m.providerOptions)).toEqual([undefined, { mock: { bp: 'AGENT_PREFIX' } }, { mock: { bp: 'CONVERSATION_CONTEXT' } }]);
    expect(result.warnings).toEqual(['unsupported: temperature']);
    expect(result.identity.requestId).toBe('resp_1');
  });

  it('does not send the portable reasoning option to non-reasoning models', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('ok') });
    await createAiSdkAdapter(spec(model, { capabilities: () => caps({ reasoning: false }) })).generate(standardRequest({ reasoning: 'high' }), 'm');
    expect(model.doGenerateCalls[0]?.reasoning).toBeUndefined();
  });

  it('ignores breakpoint markers when the cache policy is OFF', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('ok') });
    await createAiSdkAdapter(spec(model)).generate(standardRequest({ cache: { policy: 'OFF' } }), 'm');
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain('"bp"');
  });

  it('returns structured output parsed against the response schema', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('{"intent":"refund","confidence":0.9}') });
    const schema = { type: 'object', properties: { intent: { type: 'string' }, confidence: { type: 'number' } }, required: ['intent'] };
    const result = await createAiSdkAdapter(spec(model)).generate(standardRequest({ tools: [], responseSchema: schema }), 'm');
    expect(result.structured).toEqual({ intent: 'refund', confidence: 0.9 });
    expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({ type: 'json', schema });
  });

  it('fails invalid structured output as a retriable provider error', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('not json') });
    const schema = { type: 'object', properties: { intent: { type: 'string' } } };
    await expect(createAiSdkAdapter(spec(model)).generate(standardRequest({ tools: [], responseSchema: schema }), 'm')).rejects.toMatchObject({
      category: 'provider_unavailable',
      code: 'model_structured_output_invalid',
    });
  });

  it('fails clearly before calling the provider when a capability is missing', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('ok') });
    const adapter = createAiSdkAdapter(spec(model, { capabilities: () => caps({ imageInput: false, structuredOutput: false }) }));
    const withImage = standardRequest({
      messages: [{ role: 'user', content: [{ type: 'image', blobKey: 'b', mimeType: 'image/png' }] }],
    });
    await expect(adapter.generate(withImage, 'm')).rejects.toMatchObject({ code: 'model_capability_missing', details: { capability: 'imageInput' } });
    await expect(adapter.generate(standardRequest({ responseSchema: { type: 'object' } }), 'm')).rejects.toMatchObject({
      details: { capability: 'structuredOutput' },
    });
    await expect(collect(adapter.stream(standardRequest({ maxOutputTokens: 0 }), 'm'))).rejects.toMatchObject({ code: 'model_request_invalid' });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('health() is UNCONFIGURED without a model and never throws', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('boom');
      },
    });
    const adapter = createAiSdkAdapter(spec(model, { healthModel: null }));
    await expect(adapter.health()).resolves.toMatchObject({ status: 'UNCONFIGURED', latencyMs: null });
    await expect(adapter.health('m')).resolves.toMatchObject({ status: 'DOWN' });
  });
});
