import { asc, desc, eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { conflict, notFound, validation } from '@ocso/domain';
import { modelPricing, modelProviders, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { selectPrice, type ProviderRegistry } from '@ocso/model-providers';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { nowOf, type ActorContext } from '../shared/context.js';
import { authorize } from './access.js';
import { baseModelFor, insertCatalogPrice } from './catalog/catalog-prices.js';
import { ModelCatalogService } from './catalog/catalog-service.js';
import type { CatalogPriceInput, PricingInput, PricingPatch } from './inputs.js';
import { modelsWithoutPrice, type MissingPrice } from './pricing-missing.js';
import { pricingGoverned } from './pricing-approval.js';
import { approvalRequiredError } from '../approvals/guard.js';
import { assertPlatformWrite } from '../settings/platform-approvals.js';

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

export interface PricingServiceDeps {
  db: Db;
  /** The provider kinds a price row may name, and their catalog mappings. */
  registry: ProviderRegistry;
  /** Default: a read-only catalog service (vendored snapshot or the stored one). */
  catalog?: ModelCatalogService | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Price table used for usage cost metadata (docs/archive/specs/05 §3, ADR-027): rows the
 * Tech admin enters (manual) and rows pre-filled from the open-source model
 * catalog (catalog). Editing a catalog row makes it manual.
 * Maker–checker (PM/research/11 §4, pricing-approval.ts): a row a person adds
 * is a DRAFT until approved; a live row changes, and any row is removed, only
 * by proposal. Catalog refreshes by the system stay direct and audited.
 */
export class PricingService {
  private readonly db: Db;
  private readonly registry: ProviderRegistry;
  private readonly catalog: ModelCatalogService;
  private readonly now: (() => Date) | undefined;

  constructor(deps: PricingServiceDeps) {
    this.db = deps.db;
    this.registry = deps.registry;
    this.catalog = deps.catalog ?? new ModelCatalogService({ db: deps.db, providers: deps.registry.list() });
    this.now = deps.now;
  }

  async list(actor: ActorContext): Promise<PricingRow[]> {
    authorize(actor, Permission.PRICING_MANAGE);
    return this.db.select().from(modelPricing).orderBy(asc(modelPricing.providerKind), asc(modelPricing.modelPattern), desc(modelPricing.effectiveFrom));
  }

  async create(actor: ActorContext, input: PricingInput): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    this.registry.require(input.providerKind);
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
          // A draft: prices nothing until its ACTIVATE proposal is approved (pricing-approval.ts).
          status: 'DRAFT',
          ...(input.effectiveFrom ? { effectiveFrom: new Date(input.effectiveFrom) } : {}),
        })
        .returning();
      await recordAudit(tx, actor, {
        action: 'model_pricing.create',
        targetType: 'model_pricing',
        targetId: id,
        summary: `Added pricing for ${input.providerKind} ${input.modelPattern} (draft until approved)`,
        after: input,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: id });
      return row!;
    });
  }

  async update(actor: ActorContext, id: string, patch: PricingPatch): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    return this.db.transaction(async (tx) => {
      const [exists] = await tx.select({ id: modelPricing.id }).from(modelPricing).where(eq(modelPricing.id, id));
      if (!exists) throw notFound('model_pricing', id);
      // A draft only; a live price (approved, or a catalog row) changes by proposal: 409 approval_required.
      await assertPlatformWrite(tx, 'model_pricing', id, 'UPDATE', (t) => pricingGoverned(t, id));
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
    return modelsWithoutPrice(this.db, await this.catalog.catalog(), this.registry, nowOf({ now: this.now }));
  }

  /** Add the catalog's price for one model as a catalog-origin row. */
  async addFromCatalog(actor: ActorContext, input: CatalogPriceInput): Promise<PricingRow> {
    authorize(actor, Permission.PRICING_MANAGE);
    const definition = this.registry.require(input.providerKind);
    const now = nowOf({ now: this.now });
    let baseModel: string | null = null;
    if (input.providerId) {
      const [provider] = await this.db.select().from(modelProviders).where(eq(modelProviders.id, input.providerId));
      if (!provider) throw notFound('model_provider', input.providerId);
      if (provider.kind !== input.providerKind) throw validation('provider_kind_mismatch', 'The provider is of a different kind');
      baseModel = baseModelFor(this.registry, provider, input.model);
    }
    if (findPrice(await loadPricing(this.db), input.providerKind, input.model, now)) {
      throw conflict('model_price_exists', `${input.model} already has a price; edit that row instead`);
    }
    const match = (await this.catalog.catalog()).describe(definition.catalog, input.model, baseModel).price;
    if (!match) throw notFound('catalog_price', `${input.providerKind}:${input.model}`);
    const target = { providerKind: input.providerKind, model: input.model, baseModel };
    return this.db.transaction((tx) => insertCatalogPrice(tx, actor, target, match, now));
  }

  /** Removing a price row is always a proposal (DELETE, pricing-approval.ts): 409 approval_required here. */
  async delete(actor: ActorContext, id: string): Promise<void> {
    authorize(actor, Permission.PRICING_MANAGE);
    const [row] = await this.db.select({ id: modelPricing.id }).from(modelPricing).where(eq(modelPricing.id, id));
    if (!row) throw notFound('model_pricing', id);
    throw approvalRequiredError('model_pricing', id, 'DELETE');
  }
}
