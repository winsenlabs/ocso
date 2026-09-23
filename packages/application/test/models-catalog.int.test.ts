import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { auditEvents, modelCatalogSnapshots, modelPricing, uuidv7 } from '@ocso/db';
import { CATALOG_URLS } from '@ocso/model-providers';
import { allowlistedFetch, ModelCatalogService, systemActor, type ActorContext } from '../src/index.js';

/**
 * Catalog refresh (ADR-027): allowlisted downloads, validated normalized
 * snapshots in the DB, offline fallback, and catalog-origin price rows that
 * follow refreshes while manual rows never change.
 */

let t: TestDatabase;
const actor: ActorContext = systemActor('model-catalog', 'test-refresh', 'Model catalog refresh');
const NOW = new Date('2026-09-22T06:00:00Z');

const modelsDev = (miniInput: number) => ({
  openai: {
    models: Object.fromEntries([
      ['gpt-5.4-mini', { name: 'GPT-5.4 mini', cost: { input: miniInput, output: 4.5, cache_read: 0.075 } }],
      ['gpt-5.4-nano', { name: 'GPT-5.4 nano', cost: { input: 0.2, output: 1.25 } }],
      // Padding so the document passes the "too small" sanity check (≥ 50 models).
      ...Array.from({ length: 60 }, (_, i) => [`pad-${i}`, { cost: { input: 1, output: 1 } }]),
    ]),
  },
});
const litellm = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`gpt-pad-${i}`, { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 }]));

function catalogFetch(documents: { 'models.dev'?: unknown; litellm?: unknown; status?: number }) {
  const calls: string[] = [];
  const base = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (documents.status) return new Response('unavailable', { status: documents.status });
    const body = url === CATALOG_URLS['models.dev'] ? documents['models.dev'] : documents.litellm;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: allowlistedFetch(base), calls };
}

async function priceRow(o: Partial<typeof modelPricing.$inferInsert>) {
  const [row] = await t.db
    .insert(modelPricing)
    .values({ id: uuidv7(), providerKind: 'OPENAI', modelPattern: 'x', inputPerMTokMicros: 1, outputPerMTokMicros: 1, effectiveFrom: new Date('2026-09-01T00:00:00Z'), ...o })
    .returning();
  return row!;
}

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe('model catalog service', () => {
  it('before any refresh, the vendored snapshot answers (offline fallback)', async () => {
    const service = new ModelCatalogService({ db: t.db });
    const catalog = await service.catalog();
    expect(catalog.status().map((s) => [s.source, s.origin])).toEqual([
      ['models.dev', 'vendored'],
      ['litellm', 'vendored'],
    ]);
    expect(service.refreshEnabled).toBe(false);
  });

  it('refresh stores validated snapshots and moves catalog-origin prices; manual rows are untouched (audited)', async () => {
    const catalogRow = await priceRow({ modelPattern: 'gpt-5.4-mini', origin: 'catalog', catalogSource: 'models.dev', catalogProvider: 'openai', catalogModelId: 'gpt-5.4-mini', inputPerMTokMicros: 700_000, outputPerMTokMicros: 4_500_000, cachedInputPerMTokMicros: 75_000 });
    const sameRow = await priceRow({ modelPattern: 'gpt-5.4-nano', origin: 'catalog', catalogSource: 'models.dev', catalogProvider: 'openai', catalogModelId: 'gpt-5.4-nano', inputPerMTokMicros: 200_000, outputPerMTokMicros: 1_250_000 });
    const manual = await priceRow({ modelPattern: 'gpt-5.4-mini', origin: 'manual', inputPerMTokMicros: 111, outputPerMTokMicros: 222 });
    const f = catalogFetch({ 'models.dev': modelsDev(0.75), litellm });
    const service = new ModelCatalogService({ db: t.db, fetch: f.fetch, now: () => NOW });

    const result = await service.refresh(actor).catch((e: unknown) => e);
    // A system actor has no permissions: the on-demand path is for Tech Admins; the worker uses refreshIfStale.
    expect(result).toMatchObject({ code: 'forbidden' });
    const run = await service.refreshIfStale(actor);
    expect(f.calls).toEqual([CATALOG_URLS['models.dev'], CATALOG_URLS.litellm]);
    expect(run).toMatchObject({
      sources: [
        { source: 'models.dev', ok: true, changed: true, entries: 62 },
        { source: 'litellm', ok: true, changed: true, entries: 120 },
      ],
      prices: { updated: 1, unchanged: 1, notInCatalog: 0 },
    });
    const [after] = await t.db.select().from(modelPricing).where(eq(modelPricing.id, catalogRow.id));
    expect(after).toMatchObject({ inputPerMTokMicros: 750_000, origin: 'catalog', catalogFetchedAt: NOW, effectiveFrom: NOW });
    const [same] = await t.db.select().from(modelPricing).where(eq(modelPricing.id, sameRow.id));
    expect(same).toMatchObject({ inputPerMTokMicros: 200_000, catalogFetchedAt: NOW, effectiveFrom: new Date('2026-09-01T00:00:00Z') });
    const [untouched] = await t.db.select().from(modelPricing).where(eq(modelPricing.id, manual.id));
    expect(untouched).toMatchObject({ inputPerMTokMicros: 111, origin: 'manual' });
    const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.targetId, catalogRow.id));
    expect(audits).toEqual([expect.objectContaining({ action: 'model_pricing.update', actorType: 'SYSTEM', summary: 'Catalog refresh (models.dev) changed the price of OPENAI gpt-5.4-mini' })]);

    const catalog = await service.catalog();
    expect(catalog.status().map((s) => [s.source, s.origin, s.entries])).toEqual([
      ['models.dev', 'database', 62],
      ['litellm', 'database', 120],
    ]);
    // Fresh within a day: no download.
    expect(await service.refreshIfStale(actor)).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  it('an unreachable or truncated catalog keeps the previous snapshot and records the failure', async () => {
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const down = new ModelCatalogService({ db: t.db, fetch: catalogFetch({ status: 503 }).fetch, now: () => later });
    const run = await down.refreshIfStale(actor);
    expect(run?.sources.map((s) => [s.source, s.ok, s.error])).toEqual([
      ['models.dev', false, 'HTTP 503'],
      ['litellm', false, 'HTTP 503'],
    ]);
    // A failed attempt is retried after an hour (not a day).
    const retry = new Date(later.getTime() + 30 * 60_000);
    const early = new ModelCatalogService({ db: t.db, fetch: catalogFetch({ status: 503 }).fetch, now: () => retry });
    expect(await early.refreshIfStale(actor)).toBeNull();
    const hourLater = new Date(later.getTime() + 61 * 60_000);
    const tiny = new ModelCatalogService({ db: t.db, fetch: catalogFetch({ 'models.dev': { openai: { models: {} } }, litellm: {} }).fetch, now: () => hourLater });
    const run2 = await tiny.refreshIfStale(actor);
    expect(run2?.sources[0]?.error).toMatch(/^catalog_too_small/);
    const rows = await t.db.select().from(modelCatalogSnapshots);
    expect(rows.find((r) => r.source === 'models.dev')).toMatchObject({ entryCount: 62, lastError: expect.stringMatching(/^catalog_too_small/) });
    const status = await down.status({ principal: { userId: uuidv7(), role: 'PLATFORM_TECH_ADMIN', displayName: 'Admin', teamIds: [], via: 'UI' }, correlationId: 'status' });
    expect(status.sources[0]).toMatchObject({ source: 'models.dev', origin: 'database', entries: 62, lastError: expect.stringMatching(/^catalog_too_small/) });
  });

  it('the allowlist blocks other hosts, also on redirects', async () => {
    const f = allowlistedFetch(async (input) =>
      String(input).includes('models.dev') ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/api.json' } }) : new Response('{}'),
    );
    await expect(f('https://evil.example.com/x')).rejects.toMatchObject({ code: 'catalog_host_not_allowed' });
    await expect(f('http://models.dev/api.json')).rejects.toMatchObject({ code: 'catalog_host_not_allowed' });
    await expect(f('https://models.dev/api.json')).rejects.toMatchObject({ code: 'catalog_host_not_allowed', details: { host: 'evil.example.com' } });
  });
});
