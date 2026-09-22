import { describe, expect, it } from 'vitest';
import { capabilityLine, filterModelOptions, formatTokens, listSummary, optionMeta, priceLine } from '../../../components/connections/profiles/model-options';
import { needsPriceReview } from '../../../components/connections/profiles/saved-prices';
import { formatCost } from '../../../components/system/cost';
import type { ModelList, ModelOption } from '../../../lib/api/model-catalog';

const option = (id: string, o: Partial<ModelOption> = {}): ModelOption => ({
  id,
  displayName: null,
  kind: 'model',
  createdAt: null,
  ownedBy: null,
  lifecycle: null,
  baseModel: null,
  contextWindow: null,
  maxOutputTokens: null,
  input: null,
  toolCalling: null,
  reasoning: null,
  catalog: null,
  catalogPrice: null,
  configuredPrice: null,
  ...o,
});

const catalogPrice = {
  source: 'models.dev' as const,
  catalogProvider: 'openai',
  catalogModelId: 'gpt-5.5',
  fetchedAt: '2026-09-22T00:00:00.000Z',
  currency: 'USD',
  inputPerMTokMicros: 5_000_000,
  outputPerMTokMicros: 30_000_000,
  cachedInputPerMTokMicros: 500_000,
  cacheWritePerMTokMicros: null,
  tiers: [{ aboveInputTokens: 272_000, inputPerMTokMicros: 10_000_000, outputPerMTokMicros: 45_000_000, cachedInputPerMTokMicros: 1_000_000, cacheWritePerMTokMicros: null }],
};

const MODELS = [
  option('gpt-5.6-sol', { displayName: 'GPT-5.6 Sol' }),
  option('gpt-5.5'),
  option('gpt-5.4-mini'),
  option('support-main', { kind: 'deployment', baseModel: 'gpt-5.5', displayName: 'support-main (gpt-5.5)' }),
  option('o4-mini'),
];

describe('model picker search', () => {
  it('empty query keeps the API order; exact, prefix, substring, then name/base-model matches', () => {
    expect(filterModelOptions(MODELS, '  ').map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
    expect(filterModelOptions(MODELS, 'gpt-5.5').map((m) => m.id)).toEqual(['gpt-5.5', 'support-main']);
    expect(filterModelOptions(MODELS, 'mini').map((m) => m.id)).toEqual(['gpt-5.4-mini', 'o4-mini']);
    expect(filterModelOptions(MODELS, 'SOL').map((m) => m.id)).toEqual(['gpt-5.6-sol']);
    expect(filterModelOptions(MODELS, 'claude')).toEqual([]);
    expect(filterModelOptions(MODELS, '', 2)).toHaveLength(2);
  });
});

describe('capability and price lines', () => {
  it('shows only what the provider or catalog reported', () => {
    expect(capabilityLine(option('x'))).toBe('');
    expect(capabilityLine(option('x', { contextWindow: 1_050_000, input: ['text', 'image', 'pdf'], toolCalling: true, lifecycle: 'LEGACY' }))).toBe('1.05M context · text, image, pdf in · tools · legacy');
    expect(capabilityLine(option('p', { kind: 'inference-profile', baseModel: 'anthropic.claude-opus-5', contextWindow: 200_000 }))).toBe('inference profile of anthropic.claude-opus-5 · 200K context');
    expect(formatTokens(128_000)).toBe('128K');
    expect(formatTokens(400)).toBe('400');
  });

  it('configured price first, else the catalog offer (with its long-context tier), else "no catalog price"', () => {
    const configured = option('gpt-5.5', {
      catalogPrice,
      configuredPrice: { id: 'p1', origin: 'manual', modelPattern: 'gpt-5.5', currency: 'USD', inputPerMTokMicros: 4_000_000, outputPerMTokMicros: 28_000_000, cachedInputPerMTokMicros: null, cacheWritePerMTokMicros: null, catalogSource: null, catalogFetchedAt: null },
    });
    expect(priceLine(configured)).toEqual({ kind: 'configured', text: 'in 4.00 · out 28.00 USD / 1M · manual price' });
    expect(priceLine(option('gpt-5.5', { catalogPrice }))).toEqual({ kind: 'offer', text: 'in 5.00 · out 30.00 USD / 1M · more above 272K input · models.dev, added when you save' });
    expect(priceLine(option('ft:custom')).kind).toBe('none');
    expect(priceLine(undefined).text).toMatch(/^no catalog price/);
    expect(priceLine(option('scripted-1', { catalogPrice }), true)).toEqual({ kind: 'dev', text: 'development model · never priced' });
    expect(optionMeta(option('ft:x', { toolCalling: true }))).toBe('tools · no catalog price');
  });

  it('status line: listing errors keep free text, catalog stand-ins are labelled', () => {
    const base: ModelList = { providerId: 'p', providerKind: 'OPENAI', devOnly: false, source: 'provider', fetchedAt: '2026-09-22T00:00:00Z', cached: true, models: MODELS.slice(0, 2), error: null };
    expect(listSummary(base, 'OpenAI')).toBe('2 models from OpenAI (cached) · type to search, or enter any id.');
    expect(listSummary({ ...base, models: [], error: { category: 'authentication', code: 'provider_authentication_failed', message: 'The model provider rejected the configured credentials (HTTP 401) [OPENAI]' } }, 'OpenAI')).toBe(
      'Could not list OpenAI models: The model provider rejected the configured credentials (HTTP 401) [OPENAI]. You can still type a model id.',
    );
    expect(listSummary({ ...base, source: 'catalog', cached: false, models: [option('sarvam-105b')] }, 'Sarvam')).toBe('Sarvam has no model list endpoint; showing 1 model from the model catalog.');
    expect(listSummary({ ...base, cached: false, models: [MODELS[3]!] }, 'Foundry')).toBe('1 configured deployment from Foundry · type to search, or enter any id.');
  });
});

describe('prices after save and in telemetry', () => {
  it('reviews prices only when something was added or is missing', () => {
    const priced = { providerKind: 'OPENAI' as const, model: 'gpt-5.5', status: 'priced' as const, origin: 'catalog' as const, source: 'models.dev', priceId: 'x' };
    expect(needsPriceReview([priced])).toBe(false);
    expect(needsPriceReview([priced, { ...priced, model: 'ft:x', status: 'missing', origin: null, source: null, priceId: null }])).toBe(true);
  });

  it('cost cells say "no price" for unpriced usage and never show it as zero', () => {
    expect(formatCost(null, null, 0)).toBe('—');
    expect(formatCost(null, null, 12)).toBe('no price');
    expect(formatCost(1_234_567, 'USD', 0)).toBe('$1.23');
    expect(formatCost(1_234_567, 'USD', 3)).toBe('$1.23 + 3 unpriced');
  });
});
