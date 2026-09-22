import { eq } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { forbidden, isDomainError, notFound } from '@ocso/domain';
import { modelProviders, type Db } from '@ocso/db';
import {
  LISTING_UNSUPPORTED,
  selectPrice,
  type CatalogEntry,
  type ModelCatalog,
  type ModelProviderAdapter,
  type ProviderKind,
  type ProviderModelInfo,
} from '@ocso/model-providers';
import { nowOf, type ActorContext } from '../shared/context.js';
import { authorize } from './access.js';
import { baseModelFor, toSuggestion, type CatalogPriceSuggestion } from './catalog/catalog-prices.js';
import type { ModelCatalogService } from './catalog/catalog-service.js';
import { loadPricing, type PricingRow } from './pricing-service.js';

/** Resolves a configured provider's adapter (the API's CachedProviderAdapterSource). */
export interface AdapterLookup {
  get(providerId: string): Promise<ModelProviderAdapter>;
}

export interface ModelListServiceDeps {
  db: Db;
  adapters: AdapterLookup;
  catalog: ModelCatalogService;
  now?: (() => Date) | undefined;
  /** Listing cache per provider; default 10 minutes. */
  cacheTtlMs?: number | undefined;
}

/** The price row that costs this model today (model_pricing: catalog or manual). */
export interface ConfiguredPrice {
  id: string;
  origin: 'catalog' | 'manual';
  modelPattern: string;
  currency: string;
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
  catalogSource: string | null;
  catalogFetchedAt: string | null;
}

export interface ModelOption {
  id: string;
  displayName: string | null;
  kind: ProviderModelInfo['kind'];
  createdAt: string | null;
  ownedBy: string | null;
  lifecycle: 'ACTIVE' | 'LEGACY' | 'DEPRECATED' | null;
  baseModel: string | null;
  /** Provider-reported where available, else from the catalog. */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  input: string[] | null;
  toolCalling: boolean | null;
  reasoning: boolean | null;
  /** Catalog entry the metadata/price came from (null = the catalogs do not know this id). */
  catalog: { source: string; provider: string; id: string; fetchedAt: string } | null;
  catalogPrice: CatalogPriceSuggestion | null;
  configuredPrice: ConfiguredPrice | null;
}

export interface ModelListView {
  providerId: string;
  providerKind: ProviderKind;
  /** provider = its listing API (or configured deployments); catalog = no listing, catalog models shown instead. */
  source: 'provider' | 'catalog';
  fetchedAt: string;
  cached: boolean;
  models: ModelOption[];
  /** Listing failure (bad key, network…): a safe, typed message; `models` is then empty. */
  error: { category: string; code: string; message: string } | null;
}

interface Listing {
  source: ModelListView['source'];
  fetchedAt: Date;
  models: Array<ProviderModelInfo | CatalogEntry>;
  error: ModelListView['error'];
}

const DEFAULT_TTL_MS = 10 * 60_000;

const isCatalogEntry = (m: ProviderModelInfo | CatalogEntry): m is CatalogEntry => 'provider' in m;

function configured(row: PricingRow | undefined): ConfiguredPrice | null {
  if (!row) return null;
  return {
    id: row.id,
    origin: row.origin,
    modelPattern: row.modelPattern,
    currency: row.currency,
    inputPerMTokMicros: row.inputPerMTokMicros,
    outputPerMTokMicros: row.outputPerMTokMicros,
    cachedInputPerMTokMicros: row.cachedInputPerMTokMicros,
    cacheWritePerMTokMicros: row.cacheWritePerMTokMicros,
    catalogSource: row.catalogSource,
    catalogFetchedAt: row.catalogFetchedAt?.toISOString() ?? null,
  };
}

const LIFECYCLE_RANK = { ACTIVE: 0, LEGACY: 1, DEPRECATED: 2 } as const;

/**
 * "Which models can I pick?" for one configured provider (docs/06 §2): the
 * provider's own listing through its adapter, enriched with catalog metadata
 * and prices and the price row that would cost it. Listings are cached per
 * provider configuration for ten minutes; `refresh` (providers.manage)
 * bypasses the cache. Failures come back as a typed `error`, never thrown, so
 * a bad key or an outage shows a clear message and free-text entry still works.
 */
export class ModelListService {
  private readonly cache = new Map<string, { version: number; at: number; listing: Listing }>();

  constructor(private readonly deps: ModelListServiceDeps) {}

  async list(actor: ActorContext, providerId: string, options: { refresh?: boolean | undefined } = {}): Promise<ModelListView> {
    const principal = authorize(actor, Permission.PROVIDERS_READ);
    if (options.refresh && !can(principal, Permission.PROVIDERS_MANAGE)) throw forbidden(Permission.PROVIDERS_MANAGE, 'refreshing a model list requires providers.manage');
    const [row] = await this.deps.db.select().from(modelProviders).where(eq(modelProviders.id, providerId));
    if (!row) throw notFound('model_provider', providerId);
    const now = nowOf(this.deps);
    const version = row.updatedAt.getTime();
    const hit = this.cache.get(providerId);
    const fresh = hit && hit.version === version && now.getTime() - hit.at < (this.deps.cacheTtlMs ?? DEFAULT_TTL_MS);
    const catalog = await this.deps.catalog.catalog();
    let listing: Listing;
    if (fresh && !options.refresh) listing = hit.listing;
    else {
      listing = await this.fetchListing(providerId, row.kind, catalog, now);
      if (listing.error) this.cache.delete(providerId);
      else this.cache.set(providerId, { version, at: now.getTime(), listing });
    }
    const pricing = await loadPricing(this.deps.db);
    return {
      providerId,
      providerKind: row.kind,
      source: listing.source,
      fetchedAt: listing.fetchedAt.toISOString(),
      cached: fresh === true && !options.refresh,
      error: listing.error,
      models: this.options(row.kind, row.settings, listing.models, catalog, pricing, now),
    };
  }

  /** Drop cached listings (one provider, or all). */
  invalidate(providerId?: string): void {
    if (providerId) this.cache.delete(providerId);
    else this.cache.clear();
  }

  private async fetchListing(providerId: string, kind: ProviderKind, catalog: ModelCatalog, now: Date): Promise<Listing> {
    const fallback = (): Listing => ({ source: 'catalog', fetchedAt: now, models: catalog.entriesFor(kind), error: null });
    try {
      const adapter = await this.deps.adapters.get(providerId);
      if (!adapter.listModels) return fallback();
      return { source: 'provider', fetchedAt: now, models: await adapter.listModels(), error: null };
    } catch (error) {
      if (isDomainError(error) && error.code === LISTING_UNSUPPORTED) return fallback();
      const safe = isDomainError(error)
        ? { category: error.category, code: error.code, message: error.message }
        : { category: 'internal', code: 'model_list_failed', message: 'The model list could not be loaded' };
      return { source: 'provider', fetchedAt: now, models: [], error: safe };
    }
  }

  private options(
    kind: ProviderKind,
    settings: Readonly<Record<string, unknown>>,
    models: Listing['models'],
    catalog: ModelCatalog,
    pricing: readonly PricingRow[],
    now: Date,
  ): ModelOption[] {
    const options = models.map((m): ModelOption => {
      const listed = isCatalogEntry(m) ? null : m;
      const baseModel = listed?.baseModel ?? baseModelFor(kind, settings, m.id);
      const described = catalog.describe(kind, m.id, baseModel);
      const found = described.metadata;
      const meta = isCatalogEntry(m) ? m : found?.entry;
      return {
        id: m.id,
        displayName: listed?.displayName ?? meta?.name ?? null,
        kind: listed?.kind ?? 'model',
        createdAt: listed?.createdAt ?? null,
        ownedBy: listed?.ownedBy ?? null,
        lifecycle: listed?.lifecycle ?? (isCatalogEntry(m) && m.deprecated ? 'DEPRECATED' : null),
        baseModel,
        contextWindow: listed?.contextWindow ?? meta?.contextWindow ?? null,
        maxOutputTokens: listed?.maxOutputTokens ?? meta?.maxOutput ?? null,
        input: listed?.input ? [...listed.input] : (meta?.input ?? null),
        toolCalling: meta?.toolCalling ?? null,
        reasoning: meta?.reasoning ?? null,
        catalog: found ? { source: found.source, provider: found.entry.provider, id: found.entry.id, fetchedAt: found.fetchedAt } : null,
        catalogPrice: described.price ? toSuggestion(described.price) : null,
        configuredPrice: configured(selectPrice(pricing, kind, m.id, now)),
      };
    });
    return options.sort(
      (a, b) =>
        LIFECYCLE_RANK[a.lifecycle ?? 'ACTIVE'] - LIFECYCLE_RANK[b.lifecycle ?? 'ACTIVE'] ||
        (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
        a.id.localeCompare(b.id),
    );
  }
}
