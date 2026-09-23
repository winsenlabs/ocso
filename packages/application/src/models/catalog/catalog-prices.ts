import { and, eq } from 'drizzle-orm';
import { modelPricing, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import {
  catalogPriceToMicros,
  selectPrice,
  type CatalogPriceMatch,
  type ModelCatalog,
  type PriceTierMicros,
  type ProviderKind,
  type ProviderRegistry,
} from '@ocso/model-providers';
import { recordAudit } from '../../audit/audit.js';
import { emitEvent } from '../../events/outbox.js';
import type { ActorContext } from '../../shared/context.js';
import { parseSettings } from '../provider-config.js';
import { lockingProposal } from '../../approvals/guard.js';
import { lockPlatformObject } from '../../settings/platform-approvals.js';

type PricingRow = typeof modelPricing.$inferSelect;

/** A catalog price offered for a model (micros per 1M tokens, USD). */
export interface CatalogPriceSuggestion {
  source: CatalogPriceMatch['source'];
  catalogProvider: string;
  catalogModelId: string;
  fetchedAt: string;
  currency: 'USD';
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
  tiers: PriceTierMicros[] | null;
}

export function toSuggestion(match: CatalogPriceMatch): CatalogPriceSuggestion {
  return {
    source: match.source,
    catalogProvider: match.entry.provider,
    catalogModelId: match.entry.id,
    fetchedAt: match.fetchedAt,
    currency: 'USD',
    ...catalogPriceToMicros(match.price),
  };
}

/**
 * Underlying model of a target for catalog lookups, as the provider
 * definition declares it (e.g. a deployment's model in its settings); null =
 * the id itself, an unregistered kind, or unreadable settings.
 */
export function baseModelFor(registry: ProviderRegistry, provider: { kind: ProviderKind; settings: Readonly<Record<string, unknown>> }, model: string): string | null {
  const definition = registry.get(provider.kind);
  if (!definition?.baseModel) return null;
  try {
    return definition.baseModel(model, parseSettings(definition, provider.settings)) || null;
  } catch {
    return null;
  }
}

/** Whether usage of this kind is priced at all: registered here and not a dev-only provider (whose calls cost nothing). */
export function isPricedKind(registry: ProviderRegistry, kind: ProviderKind): boolean {
  const definition = registry.get(kind);
  return definition !== undefined && !definition.devOnly;
}

export interface PriceTarget {
  providerKind: ProviderKind;
  model: string;
  baseModel: string | null;
}

/** What a profile save found for each target's price. */
export interface PriceCheck {
  providerKind: ProviderKind;
  model: string;
  /** priced = a row already prices it; added = OCSO just added it from the catalog; missing = no price anywhere. */
  status: 'priced' | 'added' | 'missing';
  origin: 'catalog' | 'manual' | null;
  source: string | null;
  priceId: string | null;
}

const sameTiers = (a: readonly PriceTierMicros[] | null, b: readonly PriceTierMicros[] | null) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

function samePrice(row: PricingRow, next: ReturnType<typeof catalogPriceToMicros>): boolean {
  return (
    row.inputPerMTokMicros === next.inputPerMTokMicros &&
    row.outputPerMTokMicros === next.outputPerMTokMicros &&
    row.cachedInputPerMTokMicros === next.cachedInputPerMTokMicros &&
    row.cacheWritePerMTokMicros === next.cacheWritePerMTokMicros &&
    sameTiers(row.tiers, next.tiers) &&
    row.currency === 'USD'
  );
}

/** Insert one catalog-origin price row (audited as a system-derived change). */
export async function insertCatalogPrice(tx: DbOrTx, actor: ActorContext, target: PriceTarget, match: CatalogPriceMatch, now: Date): Promise<PricingRow> {
  const id = uuidv7();
  const [row] = await tx
    .insert(modelPricing)
    .values({
      id,
      providerKind: target.providerKind,
      modelPattern: target.model,
      currency: 'USD',
      ...catalogPriceToMicros(match.price),
      origin: 'catalog',
      catalogSource: match.source,
      catalogProvider: match.entry.provider,
      catalogModelId: match.entry.id,
      catalogFetchedAt: new Date(match.fetchedAt),
      effectiveFrom: now,
    })
    .returning();
  await recordAudit(tx, actor, {
    action: 'model_pricing.create',
    targetType: 'model_pricing',
    targetId: id,
    summary: `Added ${match.source} catalog price for ${target.providerKind} ${target.model}`,
    after: { ...row!, catalogSource: match.source },
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
  return row!;
}

/**
 * For each target without a price row, add one from the catalog when the
 * catalog prices it. Existing rows (catalog or manual) are left alone.
 */
export async function ensureCatalogPrices(
  db: Db,
  catalog: ModelCatalog,
  registry: ProviderRegistry,
  actor: ActorContext,
  targets: readonly PriceTarget[],
  now: Date,
): Promise<PriceCheck[]> {
  const rows = await db.select().from(modelPricing);
  const seen = new Set<string>();
  const checks: PriceCheck[] = [];
  for (const t of targets) {
    const key = `${t.providerKind} ${t.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = selectPrice(rows, t.providerKind, t.model, now);
    if (existing) {
      checks.push({ providerKind: t.providerKind, model: t.model, status: 'priced', origin: existing.origin, source: existing.catalogSource, priceId: existing.id });
      continue;
    }
    const match = catalog.describe(registry.get(t.providerKind)?.catalog, t.model, t.baseModel).price;
    if (!match) {
      checks.push({ providerKind: t.providerKind, model: t.model, status: 'missing', origin: null, source: null, priceId: null });
      continue;
    }
    const row = await db.transaction((tx) => insertCatalogPrice(tx, actor, t, match, now));
    rows.push(row);
    checks.push({ providerKind: t.providerKind, model: t.model, status: 'added', origin: 'catalog', source: match.source, priceId: row.id });
  }
  return checks;
}

export interface CatalogPriceSync {
  updated: number;
  unchanged: number;
  /** Catalog-origin rows whose catalog entry (or its price) disappeared; left as they were. */
  notInCatalog: number;
}

/**
 * After a catalog refresh: move catalog-origin rows to the catalog's current
 * price (audited, effective now). Manual rows are never touched; a row an
 * admin edits concurrently is skipped (the update is conditional on origin),
 * and so is a row an open proposal locks (counted as unchanged).
 */
export async function syncCatalogPrices(db: Db, catalog: ModelCatalog, actor: ActorContext, now: Date): Promise<CatalogPriceSync> {
  const result: CatalogPriceSync = { updated: 0, unchanged: 0, notInCatalog: 0 };
  const rows = await db.select().from(modelPricing).where(eq(modelPricing.origin, 'catalog'));
  for (const row of rows) {
    const hit = row.catalogSource && row.catalogProvider && row.catalogModelId ? catalog.get(row.catalogSource as CatalogPriceMatch['source'], row.catalogProvider, row.catalogModelId) : null;
    if (!hit?.entry.price) {
      result.notInCatalog += 1;
      continue;
    }
    const next = catalogPriceToMicros(hit.entry.price);
    const fetchedAt = new Date(hit.fetchedAt);
    const where = and(eq(modelPricing.id, row.id), eq(modelPricing.origin, 'catalog'));
    const changed = await db.transaction(async (tx) => {
      // A person's open proposal on this row locks it: the refresh must not void (or change under) their change.
      await lockPlatformObject(tx, 'model_pricing', row.id);
      if (await lockingProposal(tx, { kind: 'model_pricing' }, row.id)) return 'locked' as const;
      if (samePrice(row, next)) {
        await tx.update(modelPricing).set({ catalogFetchedAt: fetchedAt }).where(where);
        return 'unchanged' as const;
      }
      const [after] = await tx
        .update(modelPricing)
        .set({ ...next, currency: 'USD', catalogFetchedAt: fetchedAt, effectiveFrom: now, updatedAt: now })
        .where(where)
        .returning();
      if (!after) return 'skipped' as const;
      await recordAudit(tx, actor, {
        action: 'model_pricing.update',
        targetType: 'model_pricing',
        targetId: row.id,
        summary: `Catalog refresh (${hit.source}) changed the price of ${row.providerKind} ${row.modelPattern}`,
        before: row,
        after: { ...next, catalogFetchedAt: fetchedAt.toISOString() },
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: row.id });
      return 'updated' as const;
    });
    if (changed === 'unchanged' || changed === 'locked') result.unchanged += 1;
    if (changed === 'updated') result.updated += 1;
  }
  return result;
}
