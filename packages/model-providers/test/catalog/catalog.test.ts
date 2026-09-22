import { describe, expect, it } from 'vitest';
import { buildSnapshot, ModelCatalog } from '../../src/catalog/catalog.js';
import { normalizeLiteLlm, perMillion } from '../../src/catalog/litellm.js';
import { normalizeModelsDev, tierThreshold } from '../../src/catalog/models-dev.js';
import { CatalogSnapshotSchema } from '../../src/catalog/types.js';
import { vendoredSnapshots } from '../../src/catalog/vendored.js';
import { catalogProvidersOf, createDefaultRegistry, FIRST_PARTY_PROVIDERS } from '../../src/registry.js';

/** Each provider definition carries its own catalog mapping (ADR-027); tests look it up by kind. */
const registry = createDefaultRegistry({ enableDevProviders: true });
const mapping = (kind: string) => registry.get(kind)?.catalog;
const catalogCandidates = (kind: string, model: string, base?: string) => mapping(kind)?.candidates(model, base ?? null) ?? [];

/** Excerpts in the shape of models.dev api.json and LiteLLM's price map (research/09 §5). */
const MODELS_DEV = {
  openai: {
    id: 'openai',
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1_050_000, output: 128_000 },
        cost: { input: 5, output: 30, cache_read: 0.5, tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272_000 } }] },
      },
      'gpt-4o-mini': { name: 'GPT-4o mini', modalities: { input: ['text', 'image'] }, limit: { context: 128_000, output: 16_384 }, cost: { input: 0.15, output: 0.6, cache_read: 0.075 } },
      'gpt-legacy': { name: 'Legacy', status: 'deprecated', cost: { input: 1, output: 2 } },
      broken: { cost: 'not-an-object' },
    },
  },
  anthropic: {
    models: {
      'claude-haiku-4-5': { name: 'Claude Haiku 4.5', cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
      'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
      'claude-sonnet-4-5': { cost: { input: 3, output: 15, context_over_200k: { input: 6, output: 22.5 } } },
    },
  },
  'amazon-bedrock': {
    models: {
      'anthropic.claude-opus-5': { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
      'us.anthropic.claude-opus-5': { cost: { input: 5.5, output: 27.5, cache_read: 0.55, cache_write: 6.875 } },
    },
  },
  'google-vertex-anthropic': { models: { 'claude-opus-5@default': { cost: { input: 5, output: 25 } } } },
  'google-vertex': { models: { 'gemini-2.5-pro': { cost: { input: 1.25, output: 10, tiers: [{ input: 2.5, output: 15, tier: { type: 'context', size: 200_001 } }] } } } },
  azure: { models: { 'gpt-5.4-mini': { cost: { input: 0.75, output: 4.5, cache_read: 0.075 } } } },
  sarvam: { models: { 'sarvam-105b': { name: 'Sarvam-105B', limit: { context: 131_072 } } } },
  groq: { models: { 'llama-x': { cost: { input: 0.1, output: 0.1 } } } },
};

const LITELLM = {
  sample_spec: { litellm_provider: 'one of …', mode: 'one of …' },
  'gpt-5.5-2026-04-23': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 3e-5,
    cache_read_input_token_cost: 5e-7,
    input_cost_per_token_above_272k_tokens: 1e-5,
    output_cost_per_token_above_272k_tokens: 4.5e-5,
    input_cost_per_token_flex: 2.5e-6,
    max_input_tokens: 1_050_000,
    max_output_tokens: 128_000,
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
  },
  'sarvam-105b': { litellm_provider: 'openrouter', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  'text-embedding-3-small': { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: 2e-8, output_cost_per_token: 0 },
  'vertex_ai/claude-haiku-4-5@20251001': { litellm_provider: 'vertex_ai-anthropic_models', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  'azure/gpt-5.6-terra': { litellm_provider: 'azure', mode: 'responses', input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5, cache_creation_input_token_cost: 2.5e-6 },
};

const NOW = new Date('2026-09-22T10:00:00Z');
const catalog = new ModelCatalog([
  { snapshot: buildSnapshot('litellm', LITELLM, NOW), origin: 'database' },
  { snapshot: buildSnapshot('models.dev', MODELS_DEV, NOW), origin: 'database' },
]);

describe('models.dev normalization', () => {
  it('keeps mapped providers only, prices per 1M tokens, tiers with their input threshold', () => {
    const entries = normalizeModelsDev(MODELS_DEV);
    expect(new Set(entries.map((e) => e.provider))).toEqual(new Set(['openai', 'anthropic', 'amazon-bedrock', 'google-vertex-anthropic', 'google-vertex', 'azure', 'sarvam']));
    expect(entries.find((e) => e.id === 'gpt-5.5')).toEqual({
      provider: 'openai',
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      input: ['text', 'image', 'pdf'],
      toolCalling: true,
      reasoning: true,
      price: { input: 5, output: 30, cacheRead: 0.5, tiers: [{ aboveInputTokens: 272_000, input: 10, output: 45, cacheRead: 1 }] },
    });
    expect(entries.find((e) => e.id === 'gpt-legacy')).toMatchObject({ deprecated: true });
    expect(entries.find((e) => e.id === 'broken')).toBeUndefined();
    expect(entries.find((e) => e.id === 'sarvam-105b')).not.toHaveProperty('price');
    // context_over_200k is the 200K tier when no tiers are listed; 200001 means "above 200000".
    expect(entries.find((e) => e.id === 'claude-sonnet-4-5')?.price?.tiers).toEqual([{ aboveInputTokens: 200_000, input: 6, output: 22.5 }]);
    expect(tierThreshold(200_001)).toBe(200_000);
    expect(tierThreshold(272_000)).toBe(272_000);
  });
});

describe('LiteLLM normalization', () => {
  it('converts per-token costs to per-1M, maps supports_* and above_Nk tiers, drops non-chat and unmapped providers', () => {
    const entries = normalizeLiteLlm(LITELLM);
    expect(entries.map((e) => e.id).sort()).toEqual(['azure/gpt-5.6-terra', 'gpt-5.5-2026-04-23', 'vertex_ai/claude-haiku-4-5@20251001']);
    expect(entries.find((e) => e.id === 'gpt-5.5-2026-04-23')).toEqual({
      provider: 'openai',
      id: 'gpt-5.5-2026-04-23',
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      input: ['text', 'image', 'pdf'],
      toolCalling: true,
      price: { input: 5, output: 30, cacheRead: 0.5, tiers: [{ aboveInputTokens: 272_000, input: 10, output: 45 }] },
    });
    expect(perMillion(4e-6)).toBe(4);
    expect(perMillion(7.5e-8)).toBe(0.075);
  });
});

describe('catalog lookups (kind + model id → catalog key)', () => {
  const price = (kind: string, model: string, base?: string) => catalog.describe(mapping(kind), model, base).price;

  it('exact ids; models.dev first, LiteLLM for models models.dev lacks', () => {
    expect(price('OPENAI', 'gpt-5.5')).toMatchObject({ source: 'models.dev', price: { input: 5, output: 30 } });
    expect(price('OPENAI', 'gpt-5.5-2026-04-23')).toMatchObject({ source: 'litellm', entry: { id: 'gpt-5.5-2026-04-23' } });
    expect(price('ANTHROPIC', 'claude-haiku-4-5-20251001')).toMatchObject({ source: 'models.dev', price: { cacheWrite: 1.25 } });
  });

  it('a dated snapshot is priced only when the catalog lists that exact id (no family guessing)', () => {
    expect(price('OPENAI', 'gpt-4o-mini-2024-07-18')).toBeNull();
    expect(price('ANTHROPIC', 'claude-sonnet-4-5-20250929')).toBeNull();
    expect(price('OPENAI', 'gpt-5')).toBeNull();
  });

  it('Bedrock keeps region prefixes (priced separately) and never prices application-profile ARNs', () => {
    expect(price('BEDROCK', 'us.anthropic.claude-opus-5')?.price.input).toBe(5.5);
    expect(price('BEDROCK', 'anthropic.claude-opus-5')?.price.input).toBe(5);
    expect(price('BEDROCK', 'eu.anthropic.claude-opus-5')).toBeNull();
    expect(catalogCandidates('BEDROCK', 'arn:aws:bedrock:us-east-1:1:application-inference-profile/x')).toEqual([]);
  });

  it('Vertex: dateless Claude ids map to models.dev @default; dated ids and Gemini ids unchanged', () => {
    expect(price('VERTEX', 'claude-opus-5')).toMatchObject({ source: 'models.dev', entry: { provider: 'google-vertex-anthropic', id: 'claude-opus-5@default' } });
    expect(price('VERTEX', 'claude-haiku-4-5@20251001')).toMatchObject({ source: 'litellm', entry: { id: 'vertex_ai/claude-haiku-4-5@20251001' } });
    expect(price('VERTEX', 'gemini-2.5-pro')?.price.tiers).toEqual([{ aboveInputTokens: 200_000, input: 2.5, output: 15 }]);
  });

  it('Foundry prices the declared underlying model, else the deployment name', () => {
    expect(price('FOUNDRY', 'support-main', 'gpt-5.4-mini')).toMatchObject({ entry: { provider: 'azure', id: 'gpt-5.4-mini' } });
    expect(price('FOUNDRY', 'gpt-5.6-terra')).toMatchObject({ source: 'litellm', price: { cacheWrite: 2.5 } });
    expect(price('FOUNDRY', 'support-main')).toBeNull();
  });

  it('metadata without a price (Sarvam) and never-priced kinds', () => {
    expect(catalog.describe(mapping('SARVAM'), 'sarvam-105b')).toMatchObject({ metadata: { entry: { contextWindow: 131_072 } }, price: null });
    expect(catalogCandidates('DEV_SCRIPTED', 'scripted-1')).toEqual([]);
    expect(catalog.entriesFor(mapping('OPENAI')).map((e) => e.id)).toEqual(['gpt-5.5', 'gpt-4o-mini']);
    // Providers without a listing stand-in (Vertex) or without a mapping (dev, unknown kinds) list nothing.
    expect(catalog.entriesFor(mapping('VERTEX'))).toEqual([]);
    expect(catalog.entriesFor(mapping('MISTRAL'))).toEqual([]);
    expect(catalog.describe(undefined, 'gpt-5.5')).toEqual({ metadata: null, price: null });
    expect(catalog.describe(mapping('OPENAI'), '  ')).toEqual({ metadata: null, price: null });
  });

  it('the catalogs keep exactly the providers the definitions map to', () => {
    expect(catalogProvidersOf(FIRST_PARTY_PROVIDERS, 'models.dev').sort()).toEqual(['amazon-bedrock', 'anthropic', 'azure', 'google-vertex', 'google-vertex-anthropic', 'openai', 'sarvam']);
    expect(catalogProvidersOf(FIRST_PARTY_PROVIDERS, 'litellm').sort()).toEqual(['anthropic', 'azure', 'azure_ai', 'bedrock', 'bedrock_converse', 'openai', 'vertex_ai-anthropic_models', 'vertex_ai-language-models']);
    // A new provider's catalog provider is kept once its definition maps to it.
    expect(normalizeModelsDev(MODELS_DEV, ['groq']).map((e) => e.id)).toEqual(['llama-x']);
  });

  it('snapshots carry a content hash that changes with the content', () => {
    const a = buildSnapshot('models.dev', MODELS_DEV, NOW);
    const b = buildSnapshot('models.dev', { ...MODELS_DEV, azure: { models: {} } }, NOW);
    expect(CatalogSnapshotSchema.parse(a).contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(buildSnapshot('models.dev', MODELS_DEV, new Date()).contentHash).toBe(a.contentHash);
  });
});

describe('vendored snapshot', () => {
  it('ships both sources, valid, with prices for the common support models', () => {
    const snapshots = vendoredSnapshots();
    expect(snapshots.map((s) => s.source).sort()).toEqual(['litellm', 'models.dev']);
    const vendored = new ModelCatalog(snapshots.map((snapshot) => ({ snapshot, origin: 'vendored' as const })));
    expect(vendored.describe(mapping('OPENAI'), 'gpt-5.4-mini').price?.price).toMatchObject({ input: 0.75, output: 4.5 });
    expect(vendored.describe(mapping('ANTHROPIC'), 'claude-sonnet-5').price?.price).toMatchObject({ input: 2, output: 10 });
  });
});
