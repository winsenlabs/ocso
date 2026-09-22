import { asc, desc, eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { conflict, notFound, validation } from '@ocso/domain';
import { modelPricing, modelProviders, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { selectPrice } from '@ocso/model-providers';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { nowOf, type ActorContext } from '../shared/context.js';
import { authorize } from './access.js';
import { baseModelFor, insertCatalogPrice } from './catalog/catalog-prices.js';
import { ModelCatalogService } from './catalog/catalog-service.js';
import type { CatalogPriceInput, PricingInput, PricingPatch } from './inputs.js';
import { modelsWithoutPrice, type MissingPrice } from './pricing-missing.js';

export type PricingRow = typeof modelPricing.$inferSelect;

/**
 * Same rule as the usage recorder (`selectPrice`): rows effective now; an
 * exact id beats a prefix (`claude-sonnet-4-*`), manual beats catalog, then
 * the most recently effective row.
 */
export function findPrice(rows: readonly PricingRow[], providerKind: string, model: string, now: Date): PricingRow | undefined {
  return selectPrice(rows, providerKind, model, now);
}

export async function loadPricing(db: DbOrTx): Promise<PricingRow[]> {
  return db.select().from(modelPricing).orderBy(desc(modelPricing.effectiveFrom));
}

/**
 * Price table used for usage cost metadata (docs/05 §3, ADR-027): rows the
 * Tech Admin enters (manual) and rows pre-filled from the open-source model
 * catalog (catalog). Editing a catalog row makes it manual.
 */
export class PricingService {
  private readonly catalog: ModelCatalogService;

  constructor(
    private readonly db: Db,
    catalog?: ModelCatalogService,
    private readonly now?: () => Date,
  ) {
    this.catalog = catalog ?? new ModelCatalogService({ db });
  }

  async list(actor: ActorContext): Promise<PricingRow[]> {
    authorize(actor, Permission.PRICING_MANAGE);
    return this.db.select().from(modelPricing).orderBy(asc(modelPricing.providerKind), asc(modelPricing.modelPattern), desc(modelPricing.effectiveFrom));
  }

  async create(actor: ActorContext, input: PricingInput): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    const id = uuidv7();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(modelPricing)
        .values({
          id,
          providerKind: input.providerKind,
          modelPattern: input.modelPattern,
          currency: input.currency,
          inputPerMTokMicros: input.inputPerMTokMicros,
          cachedInputPerMTokMicros: input.cachedInputPerMTokMicros,
          cacheWritePerMTokMicros: input.cacheWritePerMTokMicros,
          outputPerMTokMicros: input.outputPerMTokMicros,
          origin: 'manual',
          ...(input.effectiveFrom ? { effectiveFrom: new Date(input.effectiveFrom) } : {}),
        })
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_pricing.create',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Added pricing for ${input.providerKind} ${input.modelPattern}`,
        after: input,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
      return row!;
    });
  }

  async update(actor: ActorContext, id: string, patch: PricingPatch): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(modelPricing).where(eq(modelPricing.id, id)).for('update');
      if (!before) throw notFound('model_pricing', id);
      const { effectiveFrom, ...fields } = patch;
      const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      // An admin edit is an override: the row becomes manual and catalog refreshes leave it alone.
      const [after] = await tx
        .update(modelPricing)
        .set({ ...set, origin: 'manual', updatedAt: new Date(), ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}) })
        .where(eq(modelPricing.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_pricing.update',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Updated pricing for ${before.providerKind} ${before.modelPattern}${before.origin === 'catalog' ? ' (catalog price overridden)' : ''}`,
        before,
        after: patch,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
      return after!;
    });
  }

  /** "Prices" action: models profiles or recent usage refer to that no row prices, with the catalog's offer. */
  async missing(actor: ActorContext): Promise<MissingPrice[]> {
    authorize(actor, Permission.PRICING_MANAGE);
    return modelsWithoutPrice(this.db, await this.catalog.catalog(), nowOf({ now: this.now }));
  }

  /** Add the catalog's price for one model as a catalog-origin row. */
  async addFromCatalog(actor: ActorContext, input: CatalogPriceInput): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    const now = nowOf({ now: this.now });
    let baseModel: string | null = null;
    if (input.providerId) {
      const [provider] = await this.db.select().from(modelProviders).where(eq(modelProviders.id, input.providerId));
      if (!provider) throw notFound('model_provider', input.providerId);
      if (provider.kind !== input.providerKind) throw validation('provider_kind_mismatch', 'The provider is of a different kind');
      baseModel = baseModelFor(provider.kind, provider.settings, input.model);
    }
    if (findPrice(await loadPricing(this.db), input.providerKind, input.model, now)) {
      throw conflict('model_price_exists', `${input.model} already has a price; edit that row instead`);
    }
    const match = (await this.catalog.catalog()).describe(input.providerKind, input.model, baseModel).price;
    if (!match) throw notFound('catalog_price', `${input.providerKind}:${input.model}`);
    const target = { providerKind: input.providerKind, model: input.model, baseModel };
    return this.db.transaction((tx) => insertCatalogPrice(tx, actor, target, match, now));
  }

  async delete(actor: ActorContext, id: string): Promise<void> {
    authorize(actor, Permission.PRICING_MANAGE);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.delete(modelPricing).where(eq(modelPricing.id, id)).returning();
      if (!before) throw notFound('model_pricing', id);
      await recordAudit(tx, actor, {
        action: 'model_pricing.delete',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Removed pricing for ${before.providerKind} ${before.modelPattern}`,
        before,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
    });
  }
}
