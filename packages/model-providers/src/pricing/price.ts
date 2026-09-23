import type { NormalizedUsage } from '../contract/types.js';
import type { CatalogPrice } from '../catalog/types.js';

/**
 * Price rows (model_pricing) as the cost code sees them: integer micro-units
 * per 1M tokens. Shared by the usage recorder, telemetry and the budget
 * alert so every surface prices the same way.
 */

export interface PriceTierMicros {
  /** Applies when the request's input tokens exceed this many. */
  aboveInputTokens: number;
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
}

export interface PriceLike {
  providerKind: string;
  modelPattern: string;
  effectiveFrom: Date;
  origin?: string | null | undefined;
  /** `DRAFT`: entered but not approved yet (maker–checker) — never prices anything. */
  status?: string | null | undefined;
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
  tiers?: readonly PriceTierMicros[] | null | undefined;
}

/** How a row's pattern matches a model id: exact id, or prefix (`claude-sonnet-4-*`, trailing `*` optional). */
export function patternMatch(pattern: string, model: string): 'exact' | 'prefix' | null {
  if (pattern === model) return 'exact';
  const prefix = pattern.replace(/\*$/, '');
  return prefix && model.startsWith(prefix) ? 'prefix' : null;
}

/**
 * The row that prices (kind, model) at `now`: rows effective at `now` only;
 * an exact id beats a prefix, a longer prefix beats a shorter one, a manual
 * row beats a catalog row, then the most recently effective row wins.
 * Catalog rows match their exact model id only (a catalog price for
 * `gpt-5.5` must never price `gpt-5.5-pro`); manual rows keep the prefix rule.
 * DRAFT rows (not approved yet) never price anything.
 */
export function selectPrice<T extends PriceLike>(rows: readonly T[], providerKind: string, model: string, now: Date): T | undefined {
  let best: { row: T; rank: [number, number, number, number] } | undefined;
  for (const row of rows) {
    if (row.providerKind !== providerKind || row.effectiveFrom.getTime() > now.getTime() || row.status === 'DRAFT') continue;
    const match = row.origin === 'catalog' ? (row.modelPattern === model ? 'exact' : null) : patternMatch(row.modelPattern, model);
    if (!match) continue;
    const rank: [number, number, number, number] = [
      match === 'exact' ? 1 : 0,
      row.modelPattern.length,
      row.origin === 'catalog' ? 0 : 1,
      row.effectiveFrom.getTime(),
    ];
    if (!best || compareRank(rank, best.rank) > 0) best = { row, rank };
  }
  return best?.row;
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type UsageLike = Pick<NormalizedUsage, 'inputTokens' | 'uncachedInputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'outputTokens'>;

/** Rates for one request: the highest tier whose threshold the input exceeded, else the base rates. */
export function ratesFor(price: PriceLike, inputTokens: number): Omit<PriceTierMicros, 'aboveInputTokens'> {
  const tier = [...(price.tiers ?? [])].sort((a, b) => b.aboveInputTokens - a.aboveInputTokens).find((t) => inputTokens > t.aboveInputTokens);
  return tier ?? price;
}

/**
 * Cost of one request in micro-units of the row's currency. Uncached input,
 * cache reads, cache writes and output are priced separately; a missing
 * cache price falls back to the input price.
 */
export function usageCostMicros(price: PriceLike, usage: UsageLike): number {
  const r = ratesFor(price, usage.inputTokens);
  const perToken = (micros: number, tokens: number | null) => (micros * (tokens ?? 0)) / 1_000_000;
  const micros =
    perToken(r.inputPerMTokMicros, usage.uncachedInputTokens) +
    perToken(r.cachedInputPerMTokMicros ?? r.inputPerMTokMicros, usage.cachedInputTokens) +
    perToken(r.cacheWritePerMTokMicros ?? r.inputPerMTokMicros, usage.cacheWriteTokens) +
    perToken(r.outputPerMTokMicros, usage.outputTokens);
  return Math.round(micros);
}

const toMicros = (usd: number) => Math.round(usd * 1_000_000);
const optMicros = (usd: number | undefined) => (usd === undefined ? null : toMicros(usd));

/** Catalog price (USD per 1M) → model_pricing columns (micros per 1M). */
export function catalogPriceToMicros(price: CatalogPrice): {
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
  tiers: PriceTierMicros[] | null;
} {
  const tiers = (price.tiers ?? []).map((t) => ({
    aboveInputTokens: t.aboveInputTokens,
    inputPerMTokMicros: toMicros(t.input),
    outputPerMTokMicros: toMicros(t.output),
    cachedInputPerMTokMicros: optMicros(t.cacheRead),
    cacheWritePerMTokMicros: optMicros(t.cacheWrite),
  }));
  return {
    inputPerMTokMicros: toMicros(price.input),
    outputPerMTokMicros: toMicros(price.output),
    cachedInputPerMTokMicros: optMicros(price.cacheRead),
    cacheWritePerMTokMicros: optMicros(price.cacheWrite),
    tiers: tiers.length ? tiers : null,
  };
}
