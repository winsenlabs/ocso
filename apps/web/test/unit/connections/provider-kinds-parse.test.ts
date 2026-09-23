import { describe, expect, it, vi } from 'vitest';

// The API schemas live next to the server-only client; parsing needs neither.
vi.mock('server-only', () => ({}));
vi.mock('../../../lib/api/client', () => ({ api: {} }));

const { PricingSchema, ProfileSchema, ProviderKindSchema, ProviderSchema, PriceCheckSchema } = await import('../../../lib/api/models');
const { MissingPriceSchema, ModelListSchema } = await import('../../../lib/api/model-catalog');

/** A kind this web build has never heard of (a plugin added on the API side only). */
const KIND = 'MISTRAL';
const stats = { requests: 0, errors: 0, errorRate: null, p95LatencyMs: null, p95TtftMs: null, inputTokens: 0, outputTokens: 0, cacheReadRatio: null, costMicros: null, currency: null };

describe('provider kinds are open in the web app', () => {
  it('parses every response that carries an unknown kind', () => {
    expect(ProviderKindSchema.parse({ kind: KIND, label: 'Mistral AI', devOnly: false, settings: [], credentials: [] })).toMatchObject({ kind: KIND });
    const provider = {
      id: 'p1',
      kind: KIND,
      kindLabel: KIND,
      devOnly: false,
      available: false,
      name: 'Mistral',
      region: null,
      residencyZone: null,
      settings: {},
      secretRefs: {},
      enabled: true,
      maxConcurrency: 5,
      status: 'UNTESTED',
      lastHealthAt: null,
      lastHealthLatencyMs: null,
      lastError: null,
      policy: { allowlisted: true, residency: 'NOT_REQUIRED' },
      profiles: [],
      stats24h: stats,
    };
    expect(ProviderSchema.parse(provider).kind).toBe(KIND);
    const target = { role: 'PRIMARY', providerId: 'p1', providerName: 'Mistral', providerKind: KIND, model: 'mistral-large', capabilities: null };
    const profile = ProfileSchema.parse({
      id: 'x',
      name: 'support',
      description: null,
      providerId: 'p1',
      providerName: 'Mistral',
      providerKind: KIND,
      region: null,
      model: 'mistral-large',
      temperature: null,
      maxOutputTokens: 1024,
      reasoning: null,
      timeoutMs: 30_000,
      retries: 1,
      retryBackoffMs: 400,
      cachePolicy: 'PREFIX',
      cacheTtl: null,
      fallbacks: [],
      requiredCapabilities: {},
      targets: [target],
      configVersion: 1,
      agents: [],
      stats24h: null,
      updatedAt: '2026-09-22T00:00:00Z',
    });
    // A target without a caching description (unavailable kind) parses to null, rendered as "unknown".
    expect(profile.targets[0]).toMatchObject({ providerKind: KIND, caching: null });
    expect(PricingSchema.parse({ id: 'r', providerKind: KIND, modelPattern: 'm', currency: 'USD', inputPerMTokMicros: 1, cachedInputPerMTokMicros: null, cacheWritePerMTokMicros: null, outputPerMTokMicros: 1, effectiveFrom: '2026-09-22T00:00:00Z' }).providerKind).toBe(KIND);
    expect(PriceCheckSchema.parse({ providerKind: KIND, model: 'm', status: 'missing', origin: null, source: null, priceId: null }).providerKind).toBe(KIND);
    expect(ModelListSchema.parse({ providerId: 'p1', providerKind: KIND, source: 'catalog', fetchedAt: 'x', cached: false, models: [], error: null })).toMatchObject({ devOnly: false });
    expect(MissingPriceSchema.parse({ providerKind: KIND, model: 'm', providers: [], profiles: [], requests30d: 0, catalog: null }).providerKind).toBe(KIND);
  });
});
