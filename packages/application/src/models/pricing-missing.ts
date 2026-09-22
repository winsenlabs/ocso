import { sql } from 'drizzle-orm';
import { modelPricing, modelProfiles, modelProviders, type DbOrTx } from '@ocso/db';
import { selectPrice, type ModelCatalog, type ProviderKind, type ProviderRegistry } from '@ocso/model-providers';
import { baseModelFor, isPricedKind, toSuggestion, type CatalogPriceSuggestion } from './catalog/catalog-prices.js';

/** A model in use that no price row prices (so its usage shows "no price"). */
export interface MissingPrice {
  providerKind: ProviderKind;
  model: string;
  providers: Array<{ id: string; name: string }>;
  /** Profiles using it as primary or fallback target. */
  profiles: string[];
  /** Successful requests in the last 30 days (recorded without a cost). */
  requests30d: number;
  /** What the catalog offers, or null when the catalogs do not price it. */
  catalog: CatalogPriceSuggestion | null;
}

export const MISSING_PRICE_USAGE_DAYS = 30;

interface Acc {
  providerKind: ProviderKind;
  model: string;
  providers: Map<string, { id: string; name: string; settings: Record<string, unknown> }>;
  profiles: Set<string>;
  requests30d: number;
}

/**
 * Models referenced by profiles (primary + fallbacks) or used in the last 30
 * days, without a price row. Kinds this deployment cannot price (not
 * registered, or dev-only) are left out: no price row could be added for them.
 */
export async function modelsWithoutPrice(db: DbOrTx, catalog: ModelCatalog, registry: ProviderRegistry, now: Date): Promise<MissingPrice[]> {
  const since = new Date(now.getTime() - MISSING_PRICE_USAGE_DAYS * 86_400_000);
  const [providers, profiles, pricing, usage] = await Promise.all([
    db.select({ id: modelProviders.id, kind: modelProviders.kind, name: modelProviders.name, settings: modelProviders.settings }).from(modelProviders),
    db.select({ name: modelProfiles.name, providerId: modelProfiles.providerId, model: modelProfiles.model, fallbacks: modelProfiles.fallbacks }).from(modelProfiles),
    db.select().from(modelPricing),
    db.execute<{ provider_id: string | null; provider_kind: ProviderKind | null; model: string | null; n: number }>(sql`
      SELECT provider_id, provider_kind, model, count(*)::int AS n
        FROM usage_events
       WHERE occurred_at >= ${since.toISOString()}::timestamptz AND status = 'OK' AND model IS NOT NULL AND provider_kind IS NOT NULL
       GROUP BY 1, 2, 3`),
  ]);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const acc = new Map<string, Acc>();
  const touch = (kind: ProviderKind, model: string, providerId: string | null): Acc => {
    const key = `${kind}\u0000${model}`;
    let a = acc.get(key);
    if (!a) {
      a = { providerKind: kind, model, providers: new Map(), profiles: new Set(), requests30d: 0 };
      acc.set(key, a);
    }
    const p = providerId ? byId.get(providerId) : undefined;
    if (p) a.providers.set(p.id, { id: p.id, name: p.name, settings: p.settings });
    return a;
  };
  for (const profile of profiles) {
    for (const t of [{ providerId: profile.providerId, model: profile.model }, ...profile.fallbacks]) {
      const kind = byId.get(t.providerId)?.kind;
      if (kind) touch(kind, t.model, t.providerId).profiles.add(profile.name);
    }
  }
  for (const u of usage.rows) {
    if (u.provider_kind && u.model) touch(u.provider_kind, u.model, u.provider_id).requests30d += Number(u.n);
  }
  const missing: MissingPrice[] = [];
  for (const a of acc.values()) {
    if (!isPricedKind(registry, a.providerKind) || selectPrice(pricing, a.providerKind, a.model, now)) continue;
    const first = [...a.providers.values()][0];
    const baseModel = first ? baseModelFor(registry, { kind: a.providerKind, settings: first.settings }, a.model) : null;
    const match = catalog.describe(registry.get(a.providerKind)?.catalog, a.model, baseModel).price;
    missing.push({
      providerKind: a.providerKind,
      model: a.model,
      providers: [...a.providers.values()].map(({ id, name }) => ({ id, name })),
      profiles: [...a.profiles].sort(),
      requests30d: a.requests30d,
      catalog: match ? toSuggestion(match) : null,
    });
  }
  return missing.sort((x, y) => y.requests30d - x.requests30d || x.providerKind.localeCompare(y.providerKind) || x.model.localeCompare(y.model));
}
