import { createHash } from 'node:crypto';
import type { ProviderCatalogMapping } from '../providers/definition.js';
import { firstPartyCatalogProviders } from '../registry.js';
import { normalizeLiteLlm } from './litellm.js';
import { normalizeModelsDev } from './models-dev.js';
import { CATALOG_SOURCES, type CatalogEntry, type CatalogOrigin, type CatalogPrice, type CatalogSnapshot, type CatalogSource } from './types.js';

/** A catalog entry found for a provider's model, with where it came from. */
export interface CatalogMatch {
  source: CatalogSource;
  fetchedAt: string;
  entry: CatalogEntry;
}

export interface CatalogPriceMatch extends CatalogMatch {
  price: CatalogPrice;
}

export interface CatalogDescription {
  /** Metadata (limits, input kinds, tool calling) from the first matching entry. */
  metadata: CatalogMatch | null;
  /** Price from the first matching entry that has one (models.dev before LiteLLM). */
  price: CatalogPriceMatch | null;
}

export interface CatalogSourceStatus {
  source: CatalogSource;
  origin: CatalogOrigin;
  fetchedAt: string;
  contentHash: string;
  entries: number;
}

const key = (source: string, provider: string, id: string) => `${source}\u0000${provider}\u0000${id}`;

/** sha256 of the normalized entries in a stable order (change detection). */
export function catalogHash(entries: readonly CatalogEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Normalize one fetched source document into a snapshot, keeping the models
 * of `providers` (default: the catalog providers the first-party provider
 * definitions map to). Throws on a document of the wrong shape.
 */
export function buildSnapshot(source: CatalogSource, document: unknown, fetchedAt: Date, providers: readonly string[] = firstPartyCatalogProviders(source)): CatalogSnapshot {
  const entries = source === 'models.dev' ? normalizeModelsDev(document, providers) : normalizeLiteLlm(document, providers);
  return { source, fetchedAt: fetchedAt.toISOString(), contentHash: catalogHash(entries), entries };
}

/**
 * Read-only index over the snapshots in use (ADR-027). models.dev is the
 * primary source; LiteLLM fills in models (or prices) models.dev lacks.
 */
export class ModelCatalog {
  private readonly index = new Map<string, CatalogMatch>();
  private readonly snapshots: ReadonlyArray<{ snapshot: CatalogSnapshot; origin: CatalogOrigin }>;

  constructor(snapshots: ReadonlyArray<{ snapshot: CatalogSnapshot; origin: CatalogOrigin }>) {
    this.snapshots = [...snapshots].sort((a, b) => CATALOG_SOURCES.indexOf(a.snapshot.source) - CATALOG_SOURCES.indexOf(b.snapshot.source));
    for (const { snapshot } of this.snapshots) {
      for (const entry of snapshot.entries) {
        const k = key(snapshot.source, entry.provider, entry.id);
        if (!this.index.has(k)) this.index.set(k, { source: snapshot.source, fetchedAt: snapshot.fetchedAt, entry });
      }
    }
  }

  static empty(): ModelCatalog {
    return new ModelCatalog([]);
  }

  /**
   * Metadata and price for one model through the provider's own mapping
   * (`ProviderDefinition.catalog`). No mapping, or an empty id: nothing found.
   */
  describe(mapping: ProviderCatalogMapping | undefined, model: string, baseModel?: string | null): CatalogDescription {
    const id = model.trim();
    const candidates = mapping && id ? mapping.candidates(id, baseModel ?? null) : [];
    let metadata: CatalogMatch | null = null;
    let price: CatalogPriceMatch | null = null;
    for (const source of CATALOG_SOURCES) {
      for (const c of candidates.filter((x) => x.source === source)) {
        const hit = this.index.get(key(c.source, c.provider, c.id));
        if (!hit) continue;
        metadata ??= hit;
        if (!price && hit.entry.price) price = { ...hit, price: hit.entry.price };
      }
    }
    return { metadata, price };
  }

  /** One entry by its exact catalog key (catalog-origin price rows remember theirs). */
  get(source: CatalogSource, provider: string, id: string): CatalogMatch | null {
    return this.index.get(key(source, provider, id)) ?? null;
  }

  /** Catalog-listed models of a provider (stand-in when it has no listing endpoint): its mapping's models.dev `listingProvider`. */
  entriesFor(mapping: ProviderCatalogMapping | undefined): CatalogEntry[] {
    const provider = mapping?.listingProvider;
    if (!provider) return [];
    const primary = this.snapshots.find((s) => s.snapshot.source === 'models.dev')?.snapshot;
    return (primary?.entries ?? []).filter((e) => e.provider === provider && !e.deprecated);
  }

  status(): CatalogSourceStatus[] {
    return this.snapshots.map(({ snapshot, origin }) => ({
      source: snapshot.source,
      origin,
      fetchedAt: snapshot.fetchedAt,
      contentHash: snapshot.contentHash,
      entries: snapshot.entries.length,
    }));
  }
}
