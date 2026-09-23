import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelCatalogSnapshots } from '@ocso/db';
import { buildSnapshot } from '@ocso/model-providers';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * GET /v1/model-providers/:id/models (listing + catalog + prices), model
 * pricing from the catalog (pre-fill on profile save, override, "missing"),
 * and the catalog status endpoint. OpenAI's listing is answered by a stubbed
 * global fetch (the adapter's listing uses it at call time); the catalog is a
 * controlled snapshot written to model_catalog_snapshots.
 */

const KEY = 'sk-proj-MODEL-LIST-SECRET-0123456789';
const OPENAI_LIST = {
  object: 'list',
  data: [
    { id: 'gpt-5.4-mini', object: 'model', created: 1773705600, owned_by: 'system' },
    { id: 'gpt-5.6-sol', object: 'model', created: 1783555200, owned_by: 'system' },
    { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'system' },
    { id: 'gpt-private-ft', object: 'model', created: 1750000000, owned_by: 'acme' },
  ],
};
const CATALOG = {
  openai: {
    models: {
      'gpt-5.4-mini': { name: 'GPT-5.4 mini', tool_call: true, modalities: { input: ['text', 'image'] }, limit: { context: 400_000, output: 128_000 }, cost: { input: 0.75, output: 4.5, cache_read: 0.075 } },
      'gpt-5.6-sol': { name: 'GPT-5.6 Sol', tool_call: true, modalities: { input: ['text', 'image', 'pdf'] }, limit: { context: 1_050_000 }, cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } },
    },
  },
};

let h: ApiHarness;
let admin: string;
let lead: string;
let exec: string;
let openaiId: string;
let listCalls = 0;
let openaiStatus = 200;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  for (const [email, role] of [
    ['lead@ocso.test', 'HEAD'],
    ['exec@ocso.test', 'SERVICE'],
  ] as const) {
    await h.http().post('/v1/users').set(auth(admin)).send({ email, name: role, role, password: `${role} password 1234` }).expect(201);
  }
  lead = await h.loginAs('lead@ocso.test', 'HEAD password 1234');
  exec = await h.loginAs('exec@ocso.test', 'SERVICE password 1234');
  const snapshot = buildSnapshot('models.dev', CATALOG, new Date('2026-09-20T00:00:00Z'));
  await h.db.db.insert(modelCatalogSnapshots).values({
    source: 'models.dev',
    fetchedAt: new Date(snapshot.fetchedAt),
    contentHash: snapshot.contentHash,
    entryCount: snapshot.entries.length,
    entries: snapshot.entries,
    lastAttemptAt: new Date(snapshot.fetchedAt),
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);
    listCalls += 1;
    if (openaiStatus !== 200) {
      return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key' } }), { status: openaiStatus });
    }
    return new Response(JSON.stringify(OPENAI_LIST), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const created = await h
    .http()
    .post('/v1/model-providers')
    .set(auth(admin))
    .send({ kind: 'OPENAI', name: 'OpenAI', region: 'global', residencyZone: 'GLOBAL', credentials: { apiKey: KEY } })
    .expect(201);
  openaiId = created.body.id;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await h?.close();
});

describe('GET /v1/model-providers/:id/models', () => {
  it('providers.read only; refresh needs providers.manage', async () => {
    await h.http().get(`/v1/model-providers/${openaiId}/models`).set(auth(exec)).expect(403);
    await h.http().get(`/v1/model-providers/${openaiId}/models?refresh=true`).set(auth(lead)).expect(403);
    await h.http().get('/v1/model-providers/00000000-0000-7000-8000-000000000000/models').set(auth(admin)).expect(404);
  });

  it('lists chat models from the provider with catalog metadata and prices; unknown ids get none', async () => {
    const res = await h.http().get(`/v1/model-providers/${openaiId}/models`).set(auth(lead)).expect(200);
    expect(res.body).toMatchObject({ providerId: openaiId, providerKind: 'OPENAI', source: 'provider', cached: false, error: null });
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-private-ft']);
    const mini = res.body.models.find((m: { id: string }) => m.id === 'gpt-5.4-mini');
    expect(mini).toMatchObject({
      displayName: 'GPT-5.4 mini',
      contextWindow: 400_000,
      input: ['text', 'image'],
      toolCalling: true,
      catalog: { source: 'models.dev', provider: 'openai', id: 'gpt-5.4-mini', fetchedAt: '2026-09-20T00:00:00.000Z' },
      catalogPrice: { source: 'models.dev', currency: 'USD', inputPerMTokMicros: 750_000, outputPerMTokMicros: 4_500_000, cachedInputPerMTokMicros: 75_000, cacheWritePerMTokMicros: null },
      configuredPrice: null,
    });
    const ft = res.body.models.find((m: { id: string }) => m.id === 'gpt-private-ft');
    expect(ft).toMatchObject({ catalog: null, catalogPrice: null, contextWindow: null, input: null });
    expect(listCalls).toBe(1);
  });

  it('caches per provider; refresh=true (admin) goes back to the provider', async () => {
    const cached = await h.http().get(`/v1/model-providers/${openaiId}/models`).set(auth(admin)).expect(200);
    expect(cached.body.cached).toBe(true);
    expect(listCalls).toBe(1);
    const refreshed = await h.http().get(`/v1/model-providers/${openaiId}/models?refresh=true`).set(auth(admin)).expect(200);
    expect(refreshed.body.cached).toBe(false);
    expect(listCalls).toBe(2);
  });

  it('a rejected key comes back as a typed error, never the key; failures are not cached', async () => {
    openaiStatus = 401;
    try {
      const res = await h.http().get(`/v1/model-providers/${openaiId}/models?refresh=true`).set(auth(admin)).expect(200);
      expect(res.body.models).toEqual([]);
      expect(res.body.error).toMatchObject({ category: 'authentication', code: 'provider_authentication_failed' });
      expect(res.text).not.toContain(KEY);
      await h.http().get(`/v1/model-providers/${openaiId}/models`).set(auth(admin)).expect(200);
      expect(listCalls).toBe(4);
    } finally {
      openaiStatus = 200;
    }
  });
});

describe('prices from the catalog', () => {
  let profileId: string;

  it('saving a profile pre-fills catalog prices for its targets and reports the rest as missing', async () => {
    const res = await h
      .http()
      .post('/v1/model-profiles')
      .set(auth(admin))
      .send({ name: 'support-fast', providerId: openaiId, model: 'gpt-5.4-mini', fallbacks: [{ providerId: openaiId, model: 'gpt-private-ft' }] })
      .expect(201);
    profileId = res.body.id;
    expect(res.body.prices).toEqual([
      expect.objectContaining({ providerKind: 'OPENAI', model: 'gpt-5.4-mini', status: 'added', origin: 'catalog', source: 'models.dev' }),
      expect.objectContaining({ providerKind: 'OPENAI', model: 'gpt-private-ft', status: 'missing' }),
    ]);
    const pricing = await h.http().get('/v1/model-pricing').set(auth(admin)).expect(200);
    expect(pricing.body).toEqual([
      expect.objectContaining({
        modelPattern: 'gpt-5.4-mini',
        origin: 'catalog',
        catalogSource: 'models.dev',
        catalogProvider: 'openai',
        catalogModelId: 'gpt-5.4-mini',
        catalogFetchedAt: '2026-09-20T00:00:00.000Z',
        inputPerMTokMicros: 750_000,
      }),
    ]);
    const again = await h.http().patch(`/v1/model-profiles/${profileId}`).set(auth(admin)).send({ description: 'fast' }).expect(200);
    expect(again.body.prices[0]).toMatchObject({ status: 'priced', origin: 'catalog' });
  });

  it('the model list shows the configured price; an admin edit makes the row manual', async () => {
    const list = await h.http().get(`/v1/model-providers/${openaiId}/models`).set(auth(admin)).expect(200);
    const mini = list.body.models.find((m: { id: string }) => m.id === 'gpt-5.4-mini');
    expect(mini.configuredPrice).toMatchObject({ origin: 'catalog', catalogSource: 'models.dev', inputPerMTokMicros: 750_000 });
    const [row] = (await h.http().get('/v1/model-pricing').set(auth(admin)).expect(200)).body;
    const edited = await h.http().patch(`/v1/model-pricing/${row.id}`).set(auth(admin)).send({ inputPerMTokMicros: 700_000 }).expect(200);
    expect(edited.body).toMatchObject({ origin: 'manual', inputPerMTokMicros: 700_000 });
  });

  it('"missing" lists models in use without a price; from-catalog adds one when the catalog prices it', async () => {
    await h.http().get('/v1/model-pricing/missing').set(auth(lead)).expect(403);
    const missing = await h.http().get('/v1/model-pricing/missing').set(auth(admin)).expect(200);
    expect(missing.body).toEqual([
      { providerKind: 'OPENAI', model: 'gpt-private-ft', providers: [{ id: openaiId, name: 'OpenAI' }], profiles: ['support-fast'], requests30d: 0, catalog: null },
    ]);
    await h.http().post('/v1/model-pricing/from-catalog').set(auth(admin)).send({ providerKind: 'OPENAI', model: 'gpt-private-ft' }).expect(404);
    const added = await h.http().post('/v1/model-pricing/from-catalog').set(auth(admin)).send({ providerKind: 'OPENAI', model: 'gpt-5.6-sol', providerId: openaiId }).expect(201);
    expect(added.body).toMatchObject({ origin: 'catalog', modelPattern: 'gpt-5.6-sol', cacheWritePerMTokMicros: 5_000_000 });
    await h.http().post('/v1/model-pricing/from-catalog').set(auth(admin)).send({ providerKind: 'OPENAI', model: 'gpt-5.6-sol' }).expect(409);
  });

  it('catalog status is readable by providers.read; refresh is admin-only', async () => {
    const status = await h.http().get('/v1/model-catalog').set(auth(lead)).expect(200);
    expect(status.body.sources.map((s: { source: string; origin: string }) => [s.source, s.origin])).toEqual([
      ['models.dev', 'database'],
      ['litellm', 'vendored'],
    ]);
    expect(status.body).toMatchObject({ refreshEnabled: true, refreshIntervalHours: 24 });
    await h.http().post('/v1/model-catalog/refresh').set(auth(exec)).expect(403);
    await h.http().post('/v1/model-catalog/refresh').set(auth(lead)).expect(403);
  });
});
