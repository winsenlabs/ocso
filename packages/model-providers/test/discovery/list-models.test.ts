import { describe, expect, it } from 'vitest';
import { isDomainError, type DomainError } from '@ocso/domain';
import { LISTING_UNSUPPORTED } from '../../src/discovery/http.js';
import { isOpenAiChatModel } from '../../src/discovery/openai.js';
import { anthropicProvider } from '../../src/providers/anthropic/definition.js';
import { devScriptedProvider } from '../../src/providers/dev-scripted/definition.js';
import { foundryProvider } from '../../src/providers/foundry/definition.js';
import { openAiProvider } from '../../src/providers/openai/definition.js';
import { sarvamProvider } from '../../src/providers/sarvam/definition.js';
import type { ProviderDefinition } from '../../src/providers/definition.js';
import { fakeFetch, jsonResponse, never, type Responder } from '../support/fake-fetch.js';
import { media, runtimeConfig } from '../support/requests.js';

const OPENAI_KEY = 'sk-proj-list-SECRET-0123456789';
const ANTHROPIC_KEY = 'sk-ant-list-SECRET-0123456789';

function adapter(def: ProviderDefinition, settings: Record<string, unknown>, credentials: Record<string, string>, responder: Responder) {
  const f = fakeFetch(responder);
  const a = def.create(runtimeConfig(def.kind, settings, credentials), { media, fetch: f.fetch });
  return { adapter: a, calls: f.calls };
}

async function failure(p: Promise<unknown>): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    if (isDomainError(e)) return e;
    throw e;
  }
  throw new Error('expected a failure');
}

/** Recorded shape of OpenAI GET /v1/models (research/09 §1). */
const OPENAI_LIST = {
  object: 'list',
  data: [
    { id: 'gpt-5.6-sol', object: 'model', created: 1783555200, owned_by: 'system' },
    { id: 'gpt-5.4-mini', object: 'model', created: 1773705600, owned_by: 'system' },
    { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'system' },
    { id: 'whisper-1', object: 'model', created: 1677532384, owned_by: 'openai-internal' },
    { id: 'gpt-4o-mini-tts', object: 'model', created: 1742403959, owned_by: 'system' },
    { id: 'gpt-realtime-2.1', object: 'model', created: 1780000000, owned_by: 'system' },
    { id: 'gpt-image-2', object: 'model', created: 1780000000, owned_by: 'system' },
    { id: 'dall-e-3', object: 'model', created: 1698785189, owned_by: 'system' },
    { id: 'omni-moderation-latest', object: 'model', created: 1731689265, owned_by: 'system' },
    { id: 'gpt-3.5-turbo-instruct', object: 'model', created: 1692901427, owned_by: 'system' },
    { id: 'davinci-002', object: 'model', created: 1692634301, owned_by: 'system' },
    { id: 'o4-mini', object: 'model', created: 1744225308, owned_by: 'system' },
    { id: 'ft:gpt-4.1-mini:acme::abc123', object: 'model', created: 1750000000, owned_by: 'acme' },
  ],
};

describe('OpenAI listModels', () => {
  it('GET /v1/models with the bearer key, keeping chat models only (documented filter)', async () => {
    const h = adapter(openAiProvider, { organization: 'org-1', project: 'proj-1' }, { apiKey: OPENAI_KEY }, () => jsonResponse(OPENAI_LIST));
    const models = await h.adapter.listModels!();
    expect(h.calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(h.calls[0]?.headers).toMatchObject({ authorization: `Bearer ${OPENAI_KEY}`, 'openai-organization': 'org-1', 'openai-project': 'proj-1' });
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini', 'o4-mini', 'ft:gpt-4.1-mini:acme::abc123']);
    expect(models[0]).toEqual({ id: 'gpt-5.6-sol', displayName: null, createdAt: '2026-07-09T00:00:00.000Z', ownedBy: 'system', kind: 'model' });
    // The listing documents no capabilities: none are invented.
    expect(models[0]).not.toHaveProperty('input');
  });

  it('filter rule: embeddings, audio, realtime, image/video, moderation and legacy completions are not chat models', () => {
    for (const id of ['text-embedding-3-large', 'whisper-1', 'gpt-4o-transcribe', 'tts-1', 'gpt-4o-audio-preview', 'gpt-realtime', 'dall-e-2', 'gpt-image-1', 'sora-2', 'omni-moderation-latest', 'babbage-002', 'gpt-3.5-turbo-instruct', 'gpt-4o-search-preview', 'computer-use-preview']) {
      expect(isOpenAiChatModel(id), id).toBe(false);
    }
    for (const id of ['gpt-6-astra', 'gpt-5.5-pro', 'gpt-5.3-codex', 'o3', 'chatgpt-4o-latest', 'gpt-4.1-nano']) expect(isOpenAiChatModel(id), id).toBe(true);
  });

  it('honours a custom baseURL', async () => {
    const h = adapter(openAiProvider, { baseURL: 'https://gateway.example.com/openai/v1/' }, { apiKey: OPENAI_KEY }, () => jsonResponse({ data: [] }));
    await h.adapter.listModels!();
    expect(h.calls[0]?.url).toBe('https://gateway.example.com/openai/v1/models');
  });

  it('a rejected key is a typed authentication error that never carries the key', async () => {
    const h = adapter(openAiProvider, {}, { apiKey: OPENAI_KEY }, () =>
      jsonResponse({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, code: 'invalid_api_key' } }, { status: 401 }),
    );
    const e = await failure(h.adapter.listModels!());
    expect(e).toMatchObject({ category: 'authentication', code: 'provider_authentication_failed' });
    expect(JSON.stringify({ message: e.message, details: e.details })).not.toContain(OPENAI_KEY);
  });

  it('network failures and malformed payloads are normalized', async () => {
    const down = adapter(openAiProvider, {}, { apiKey: OPENAI_KEY }, () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(await failure(down.adapter.listModels!())).toMatchObject({ category: 'provider_unavailable', code: 'provider_unreachable' });
    const garbage = adapter(openAiProvider, {}, { apiKey: OPENAI_KEY }, () => jsonResponse({ nope: true }));
    expect(await failure(garbage.adapter.listModels!())).toMatchObject({ code: 'provider_invalid_response' });
  });

  it('a caller abort surfaces as cancellation', async () => {
    const h = adapter(openAiProvider, {}, { apiKey: OPENAI_KEY }, () => never());
    const controller = new AbortController();
    const pending = h.adapter.listModels!({ abortSignal: controller.signal });
    controller.abort();
    expect(await failure(pending)).toMatchObject({ category: 'timeout', code: 'model_request_cancelled' });
  });
});

/** Recorded shape of Anthropic GET /v1/models (research/09 §2). */
const anthropicPage = (ids: string[], hasMore: boolean) => ({
  data: ids.map((id, i) => ({
    id,
    type: 'model',
    display_name: `Claude ${id}`,
    created_at: '2026-07-24T00:00:00Z',
    max_input_tokens: i === 0 ? 1_000_000 : 0,
    max_tokens: 128_000,
    capabilities: i === 0 ? { image_input: { supported: true }, pdf_input: { supported: true }, batch: { supported: true } } : null,
  })),
  first_id: ids[0] ?? null,
  last_id: ids.at(-1) ?? null,
  has_more: hasMore,
});

describe('Anthropic listModels', () => {
  it('follows after_id pagination and maps documented capabilities and limits only', async () => {
    const h = adapter(anthropicProvider, {}, { apiKey: ANTHROPIC_KEY }, (req) =>
      req.url.includes('after_id=') ? jsonResponse(anthropicPage(['claude-haiku-4-5-20251001'], false)) : jsonResponse(anthropicPage(['claude-opus-5', 'claude-sonnet-5'], true)),
    );
    const models = await h.adapter.listModels!();
    expect(h.calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5',
    ]);
    expect(h.calls[0]?.headers).toMatchObject({ 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' });
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(models[0]).toMatchObject({ displayName: 'Claude claude-opus-5', input: ['text', 'image', 'pdf'], contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    // capabilities null → no input kinds; a 0 limit is "not reported".
    expect(models[1]).not.toHaveProperty('input');
    expect(models[1]).not.toHaveProperty('contextWindow');
  });

  it('401 is a typed error without the key', async () => {
    const h = adapter(anthropicProvider, {}, { apiKey: ANTHROPIC_KEY }, () =>
      jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
    );
    const e = await failure(h.adapter.listModels!());
    expect(e.code).toBe('provider_authentication_failed');
    expect(e.message).not.toContain(ANTHROPIC_KEY);
  });
});

describe('Foundry, Sarvam and the scripted provider', () => {
  it('Foundry lists the configured deployments with their declared model', async () => {
    const h = adapter(
      foundryProvider,
      { resourceName: 'acme-ai', deployments: { 'support-main': { modelFamily: 'openai', model: 'gpt-5.4-mini' }, 'claude-opus-5': { modelFamily: 'anthropic' } } },
      { apiKey: 'foundry-key-SECRET' },
      () => jsonResponse({}),
    );
    const models = await h.adapter.listModels!();
    expect(h.calls).toHaveLength(0);
    expect(models).toEqual([
      { id: 'support-main', displayName: 'support-main (gpt-5.4-mini)', createdAt: null, ownedBy: 'openai', kind: 'deployment', baseModel: 'gpt-5.4-mini' },
      { id: 'claude-opus-5', displayName: 'claude-opus-5', createdAt: null, ownedBy: 'anthropic', kind: 'deployment' },
    ]);
  });

  it('Sarvam uses its OpenAI-compatible /models; a 404 means no listing (catalog fallback)', async () => {
    const ok = adapter(sarvamProvider, {}, { apiKey: 'sarvam-key-SECRET' }, () =>
      jsonResponse({ object: 'list', data: [{ id: 'sarvam-105b', object: 'model', created: 0, owned_by: 'sarvam' }] }),
    );
    expect(await ok.adapter.listModels!()).toEqual([{ id: 'sarvam-105b', displayName: null, createdAt: null, ownedBy: 'sarvam', kind: 'model' }]);
    expect(ok.calls[0]).toMatchObject({ url: 'https://api.sarvam.ai/v1/models', headers: { 'api-subscription-key': 'sarvam-key-SECRET' } });
    const missing = adapter(sarvamProvider, {}, { apiKey: 'sarvam-key-SECRET' }, () => new Response('not found', { status: 404 }));
    expect(await failure(missing.adapter.listModels!())).toMatchObject({ code: LISTING_UNSUPPORTED });
  });

  it('DEV_SCRIPTED offers its conventional ids', async () => {
    const h = adapter(devScriptedProvider, { healthModel: 'scripted-fast' }, {}, () => jsonResponse({}));
    expect((await h.adapter.listModels!()).map((m) => m.id)).toEqual(['scripted-1', 'scripted-2', 'scripted-fast']);
  });
});
