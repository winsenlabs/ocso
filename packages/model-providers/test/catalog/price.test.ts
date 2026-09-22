import { describe, expect, it } from 'vitest';
import { catalogPriceToMicros, ratesFor, selectPrice, usageCostMicros, type PriceLike } from '../../src/pricing/price.js';

const T0 = new Date('2026-09-01T00:00:00Z');
const NOW = new Date('2026-09-22T00:00:00Z');

const row = (o: Partial<PriceLike> & Pick<PriceLike, 'modelPattern'>): PriceLike => ({
  providerKind: 'OPENAI',
  effectiveFrom: T0,
  origin: 'manual',
  inputPerMTokMicros: 1_000_000,
  outputPerMTokMicros: 2_000_000,
  cachedInputPerMTokMicros: null,
  cacheWritePerMTokMicros: null,
  ...o,
});

describe('selectPrice', () => {
  it('exact beats prefix, longer prefix beats shorter, manual beats catalog, then latest effective; future rows ignored', () => {
    const prefix = row({ modelPattern: 'gpt-5*' });
    const longer = row({ modelPattern: 'gpt-5.5*' });
    const catalog = row({ modelPattern: 'gpt-5.5', origin: 'catalog' });
    const manual = row({ modelPattern: 'gpt-5.5', effectiveFrom: new Date('2026-08-01T00:00:00Z') });
    const future = row({ modelPattern: 'gpt-5.5', effectiveFrom: new Date('2026-10-01T00:00:00Z') });
    expect(selectPrice([prefix, longer], 'OPENAI', 'gpt-5.5', NOW)).toBe(longer);
    expect(selectPrice([prefix, longer, catalog], 'OPENAI', 'gpt-5.5', NOW)).toBe(catalog);
    expect(selectPrice([catalog, manual, future], 'OPENAI', 'gpt-5.5', NOW)).toBe(manual);
    expect(selectPrice([catalog], 'ANTHROPIC', 'gpt-5.5', NOW)).toBeUndefined();
    // Manual rows keep the legacy prefix rule (trailing * optional); catalog rows are exact-id only.
    expect(selectPrice([row({ modelPattern: 'gpt-5.5' })], 'OPENAI', 'gpt-5.5-pro', NOW)).toBeDefined();
    expect(selectPrice([catalog], 'OPENAI', 'gpt-5.5-pro', NOW)).toBeUndefined();
  });
});

describe('usageCostMicros', () => {
  const price = row({
    modelPattern: 'gpt-5.5',
    inputPerMTokMicros: 5_000_000,
    outputPerMTokMicros: 30_000_000,
    cachedInputPerMTokMicros: 500_000,
    tiers: [{ aboveInputTokens: 272_000, inputPerMTokMicros: 10_000_000, outputPerMTokMicros: 45_000_000, cachedInputPerMTokMicros: 1_000_000, cacheWritePerMTokMicros: null }],
  });

  it('prices uncached input, cache reads, cache writes (input price when unpriced) and output', () => {
    const usage = { inputTokens: 10_000, uncachedInputTokens: 6_000, cachedInputTokens: 3_000, cacheWriteTokens: 1_000, outputTokens: 500 };
    // 6000×5 + 3000×0.5 + 1000×5 + 500×30 (USD per 1M) = 0.03 + 0.0015 + 0.005 + 0.015 = 0.0515 USD
    expect(usageCostMicros(price, usage)).toBe(51_500);
  });

  it('applies the long-context tier when the request input exceeds its threshold', () => {
    expect(ratesFor(price, 272_000)).toBe(price);
    expect(ratesFor(price, 272_001).inputPerMTokMicros).toBe(10_000_000);
    const usage = { inputTokens: 300_000, uncachedInputTokens: 300_000, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 1_000 };
    expect(usageCostMicros(price, usage)).toBe(3_000_000 + 45_000);
  });

  it('catalog USD per 1M → micros per 1M, including tiers', () => {
    expect(catalogPriceToMicros({ input: 0.075, output: 4.5, cacheRead: 0.0075, tiers: [{ aboveInputTokens: 200_000, input: 0.15, output: 9 }] })).toEqual({
      inputPerMTokMicros: 75_000,
      outputPerMTokMicros: 4_500_000,
      cachedInputPerMTokMicros: 7_500,
      cacheWritePerMTokMicros: null,
      tiers: [{ aboveInputTokens: 200_000, inputPerMTokMicros: 150_000, outputPerMTokMicros: 9_000_000, cachedInputPerMTokMicros: null, cacheWritePerMTokMicros: null }],
    });
  });
});
