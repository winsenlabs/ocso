import { eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { isDomainError, validation } from '@ocso/domain';
import { modelCatalogSnapshots, type Db } from '@ocso/db';
import type { FetchFn } from '@ocso/mcp';
import {
  buildSnapshot,
  CATALOG_HOMEPAGES,
  CATALOG_SOURCES,
  CATALOG_URLS,
  CatalogSnapshotSchema,
  ModelCatalog,
  snapshotCatalogProviders,
  vendoredSnapshots,
  type ProviderDefinition,
  type CatalogOrigin,
  type CatalogSnapshot,
  type CatalogSource,
} from '@ocso/model-providers';
import { nowOf, type ActorContext } from '../../shared/context.js';
import { authorizeAny } from '../access.js';
import { syncCatalogPrices, type CatalogPriceSync } from './catalog-prices.js';

export interface ModelCatalogServiceDeps {
  db: Db;
  /** Allowlisted, SSRF-guarded fetch (`createCatalogFetch().fetch`). Absent = refresh disabled (read-only). */
  fetch?: FetchFn | undefined;
  now?: (() => Date) | undefined;
  /**
   * The provider definitions this deployment registered (`registry.list()`,
   * installed plugins included). Snapshots keep the catalog providers they
   * map to, on top of the first-party ones; absent = first-party only.
   */
  providers?: readonly ProviderDefinition[] | undefined;
}

export interface CatalogSourceView {
  source: CatalogSource;
  origin: CatalogOrigin;
  /** Upstream document and human page. */
  url: string;
  homepage: string;
  fetchedAt: string;
  contentHash: string;
  entries: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface CatalogStatusView {
  sources: CatalogSourceView[];
  refreshEnabled: boolean;
  refreshIntervalHours: number;
}

export interface CatalogRefreshResult {
  refreshedAt: string;
  sources: Array<{ source: CatalogSource; ok: boolean; changed: boolean; entries: number | null; error: string | null }>;
  prices: CatalogPriceSync;
}

export const CATALOG_REFRESH_INTERVAL_HOURS = 24;
const eqSource = (source: CatalogSource) => eq(modelCatalogSnapshots.source, source);
const CACHE_TTL_MS = 5 * 60_000;
const RETRY_AFTER_FAILURE_MS = 3_600_000;
/** A document this small is truncated or wrong; keep the previous snapshot. */
const MIN_ENTRIES: Readonly<Record<CatalogSource, number>> = { 'models.dev': 50, litellm: 100 };

/** Safe, short failure text for the status panel (never a response body). */
function failureText(error: unknown): string {
  if (isDomainError(error)) return `${error.code}: ${error.message}`.slice(0, 200);
  if (error instanceof Error && /^(HTTP \d{3}|catalog_)/.test(error.message)) return error.message.slice(0, 200);
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timed out';
  return 'fetch or parse failed';
}

/**
 * The open-source model catalog OCSO prices and describes models with
 * (ADR-027): the latest validated snapshot per source from the database,
 * falling back to the vendored snapshot, so a catalog outage never fails a
 * request. `refresh()` downloads both sources through the allowlisted
 * fetch, stores changed snapshots, and moves catalog-origin price rows to
 * the new prices (audited; manual rows are never touched).
 */
export class ModelCatalogService {
  private cache: { at: number; catalog: ModelCatalog } | null = null;
  /** Failures of sources that have no stored snapshot yet (nothing to annotate in the DB). */
  private readonly unsavedFailures = new Map<CatalogSource, { at: Date; error: string }>();

  constructor(private readonly deps: ModelCatalogServiceDeps) {}

  get refreshEnabled(): boolean {
    return this.deps.fetch !== undefined;
  }

  /** The catalog in use (cached for five minutes; refresh() invalidates). */
  async catalog(): Promise<ModelCatalog> {
    return this.load();
  }

  invalidate(): void {
    this.cache = null;
  }

  async status(actor: ActorContext): Promise<CatalogStatusView> {
    authorizeAny(actor, [Permission.PROVIDERS_READ, Permission.PRICING_MANAGE]);
    const catalog = await this.catalog();
    // Attempts are read fresh: the worker refreshes in another process.
    const rows = await this.deps.db
      .select({ source: modelCatalogSnapshots.source, at: modelCatalogSnapshots.lastAttemptAt, error: modelCatalogSnapshots.lastError })
      .from(modelCatalogSnapshots);
    const attempts = new Map(rows.map((r) => [r.source, { at: r.at, error: r.error }]));
    return {
      sources: catalog.status().map((s) => {
        const attempt = attempts.get(s.source) ?? this.unsavedFailures.get(s.source) ?? null;
        return {
          ...s,
          url: CATALOG_URLS[s.source],
          homepage: CATALOG_HOMEPAGES[s.source],
          lastAttemptAt: attempt?.at.toISOString() ?? null,
          lastError: attempt?.error ?? null,
        };
      }),
      refreshEnabled: this.refreshEnabled,
      refreshIntervalHours: CATALOG_REFRESH_INTERVAL_HOURS,
    };
  }

  /** On-demand refresh by a Tech admin. */
  async refresh(actor: ActorContext): Promise<CatalogRefreshResult> {
    authorizeAny(actor, [Permission.PRICING_MANAGE, Permission.PROVIDERS_MANAGE]);
    if (!this.deps.fetch) throw validation('catalog_refresh_disabled', 'Model catalog refresh is not available in this process');
    return this.runRefresh(actor);
  }

  /** Worker leader task: refresh when any source is older than `maxAgeMs` (or never stored). */
  async refreshIfStale(actor: ActorContext, maxAgeMs = (CATALOG_REFRESH_INTERVAL_HOURS - 1) * 3_600_000): Promise<CatalogRefreshResult | null> {
    if (!this.deps.fetch) return null;
    const rows = await this.deps.db
      .select({ source: modelCatalogSnapshots.source, lastAttemptAt: modelCatalogSnapshots.lastAttemptAt, lastError: modelCatalogSnapshots.lastError })
      .from(modelCatalogSnapshots);
    const now = nowOf(this.deps).getTime();
    // A failed attempt is retried after an hour rather than a day.
    const fresh = CATALOG_SOURCES.every((source) => {
      const row = rows.find((r) => r.source === source);
      const attempt = row ? { at: row.lastAttemptAt, failed: row.lastError !== null } : this.unsavedFailures.has(source) ? { at: this.unsavedFailures.get(source)!.at, failed: true } : null;
      return attempt !== null && now - attempt.at.getTime() < (attempt.failed ? RETRY_AFTER_FAILURE_MS : maxAgeMs);
    });
    return fresh ? null : this.runRefresh(actor);
  }

  private async runRefresh(actor: ActorContext): Promise<CatalogRefreshResult> {
    const fetchFn = this.deps.fetch!;
    const now = nowOf(this.deps);
    const sources: CatalogRefreshResult['sources'] = [];
    for (const source of CATALOG_SOURCES) {
      try {
        const response = await fetchFn(CATALOG_URLS[source], { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = buildSnapshot(source, await response.json(), now, snapshotCatalogProviders(source, this.deps.providers));
        if (snapshot.entries.length < MIN_ENTRIES[source]) throw new Error('catalog_too_small: fewer models than expected; keeping the previous snapshot');
        sources.push({ source, ok: true, changed: await this.store(snapshot, now), entries: snapshot.entries.length, error: null });
        this.unsavedFailures.delete(source);
      } catch (error) {
        const text = failureText(error);
        await this.recordFailure(source, now, text);
        sources.push({ source, ok: false, changed: false, entries: null, error: text });
      }
    }
    this.invalidate();
    const prices = await syncCatalogPrices(this.deps.db, await this.catalog(), actor, now);
    return { refreshedAt: now.toISOString(), sources, prices };
  }

  /** Upsert one source's snapshot; returns whether the content changed. */
  private async store(snapshot: CatalogSnapshot, now: Date): Promise<boolean> {
    const [before] = await this.deps.db
      .select({ hash: modelCatalogSnapshots.contentHash })
      .from(modelCatalogSnapshots)
      .where(eqSource(snapshot.source));
    const values = {
      fetchedAt: new Date(snapshot.fetchedAt),
      contentHash: snapshot.contentHash,
      entryCount: snapshot.entries.length,
      entries: snapshot.entries,
      lastAttemptAt: now,
      lastError: null,
      updatedAt: now,
    };
    await this.deps.db
      .insert(modelCatalogSnapshots)
      .values({ source: snapshot.source, ...values })
      .onConflictDoUpdate({ target: modelCatalogSnapshots.source, set: values });
    return before?.hash !== snapshot.contentHash;
  }

  private async recordFailure(source: CatalogSource, now: Date, error: string): Promise<void> {
    const updated = await this.deps.db
      .update(modelCatalogSnapshots)
      .set({ lastAttemptAt: now, lastError: error, updatedAt: now })
      .where(eqSource(source))
      .returning({ source: modelCatalogSnapshots.source });
    if (!updated.length) this.unsavedFailures.set(source, { at: now, error });
  }

  private async load(): Promise<ModelCatalog> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.catalog;
    const rows = await this.deps.db.select().from(modelCatalogSnapshots);
    const vendored = vendoredSnapshots();
    const chosen: Array<{ snapshot: CatalogSnapshot; origin: CatalogOrigin }> = [];
    for (const source of CATALOG_SOURCES) {
      const row = rows.find((r) => r.source === source);
      const stored = row
        ? CatalogSnapshotSchema.safeParse({ source, fetchedAt: row.fetchedAt.toISOString(), contentHash: row.contentHash, entries: row.entries })
        : null;
      if (stored?.success) chosen.push({ snapshot: stored.data, origin: 'database' });
      else {
        const fallback = vendored.find((s) => s.source === source);
        if (fallback) chosen.push({ snapshot: fallback, origin: 'vendored' });
      }
    }
    this.cache = { at: Date.now(), catalog: new ModelCatalog(chosen) };
    return this.cache.catalog;
  }
}
