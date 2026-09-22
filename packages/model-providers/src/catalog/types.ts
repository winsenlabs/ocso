import { z } from 'zod';

/**
 * Normalized open-source model catalog (ADR-027, research/09). OCSO keeps no
 * hand-maintained price table: prices and model metadata come from
 * models.dev (primary) and LiteLLM's model_prices_and_context_window.json
 * (fallback), normalized to this shape. Prices are USD per 1M tokens, exactly
 * as the catalog states them (converted from per-token for LiteLLM).
 */

export const CATALOG_SOURCES = ['models.dev', 'litellm'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

export const CATALOG_URLS: Readonly<Record<CatalogSource, string>> = {
  'models.dev': 'https://models.dev/api.json',
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
};

/** Human-facing pages for the source link next to a price. */
export const CATALOG_HOMEPAGES: Readonly<Record<CatalogSource, string>> = {
  'models.dev': 'https://models.dev',
  litellm: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
};

const usd = z.number().finite().min(0).max(100_000);

export const CatalogPriceTierSchema = z.object({
  /** The tier applies when the request's input tokens exceed this many. */
  aboveInputTokens: z.number().int().positive(),
  input: usd,
  output: usd,
  cacheRead: usd.optional(),
  cacheWrite: usd.optional(),
});
export type CatalogPriceTier = z.infer<typeof CatalogPriceTierSchema>;

export const CatalogPriceSchema = z.object({
  input: usd,
  output: usd,
  cacheRead: usd.optional(),
  cacheWrite: usd.optional(),
  tiers: z.array(CatalogPriceTierSchema).optional(),
});
export type CatalogPrice = z.infer<typeof CatalogPriceSchema>;

export const INPUT_KINDS = ['text', 'image', 'pdf', 'audio', 'video'] as const;

export const CatalogEntrySchema = z.object({
  /** Catalog provider key: models.dev provider id, or LiteLLM `litellm_provider`. */
  provider: z.string().min(1),
  /** Model key exactly as the catalog spells it. */
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  input: z.array(z.enum(INPUT_KINDS)).optional(),
  toolCalling: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  price: CatalogPriceSchema.optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSnapshotSchema = z.object({
  source: z.enum(CATALOG_SOURCES),
  /** When OCSO fetched the source document (ISO). */
  fetchedAt: z.iso.datetime({ offset: true }),
  /** sha256 of the normalized entries (change detection). */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(CatalogEntrySchema),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

/** Where the snapshot in use came from. */
export type CatalogOrigin = 'database' | 'vendored';
