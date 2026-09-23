import 'server-only';
import { z } from 'zod';
import { api } from './client';
import { PriceTierSchema, PricingSchema, type ProviderKind } from './models';

/**
 * Model discovery and the open-source model catalog (ADR-027): what a
 * configured provider offers (GET /v1/model-providers/:id/models), catalog
 * prices for models in use without a price, and the catalog's own status.
 * Shapes mirror packages/application/src/models/{model-list-service,pricing-missing,catalog/*}.ts.
 */

/** Open: any kind the API's provider registry holds. */
const Kind = z.string();

/** A catalog price offered for a model (micro-USD per 1M tokens). */
export const CatalogPriceSchema = z.object({
  source: z.enum(['models.dev', 'litellm']),
  catalogProvider: z.string(),
  catalogModelId: z.string(),
  fetchedAt: z.string(),
  currency: z.string(),
  inputPerMTokMicros: z.number(),
  outputPerMTokMicros: z.number(),
  cachedInputPerMTokMicros: z.number().nullable(),
  cacheWritePerMTokMicros: z.number().nullable(),
  tiers: z.array(PriceTierSchema).nullable(),
});
export type CatalogPrice = z.infer<typeof CatalogPriceSchema>;

const ConfiguredPriceSchema = z.object({
  id: z.string(),
  origin: z.enum(['catalog', 'manual']),
  modelPattern: z.string(),
  currency: z.string(),
  inputPerMTokMicros: z.number(),
  outputPerMTokMicros: z.number(),
  cachedInputPerMTokMicros: z.number().nullable(),
  cacheWritePerMTokMicros: z.number().nullable(),
  catalogSource: z.string().nullable(),
  catalogFetchedAt: z.string().nullable(),
});
export type ConfiguredPrice = z.infer<typeof ConfiguredPriceSchema>;

export const ModelOptionSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  kind: z.enum(['model', 'inference-profile', 'deployment']),
  createdAt: z.string().nullable(),
  ownedBy: z.string().nullable(),
  lifecycle: z.enum(['ACTIVE', 'LEGACY', 'DEPRECATED']).nullable(),
  baseModel: z.string().nullable(),
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  input: z.array(z.string()).nullable(),
  toolCalling: z.boolean().nullable(),
  reasoning: z.boolean().nullable(),
  catalog: z.object({ source: z.string(), provider: z.string(), id: z.string(), fetchedAt: z.string() }).nullable(),
  catalogPrice: CatalogPriceSchema.nullable(),
  configuredPrice: ConfiguredPriceSchema.nullable(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/** GET /v1/model-providers/:id/models. `error` = the listing failed (bad key, outage); free text still works. */
export const ModelListSchema = z.object({
  providerId: z.string(),
  providerKind: Kind,
  /** A development-only provider: its models are never priced. */
  devOnly: z.boolean().default(false),
  source: z.enum(['provider', 'catalog']),
  fetchedAt: z.string(),
  cached: z.boolean(),
  models: z.array(ModelOptionSchema),
  error: z.object({ category: z.string(), code: z.string(), message: z.string() }).nullable(),
});
export type ModelList = z.infer<typeof ModelListSchema>;

export const MissingPriceSchema = z.object({
  providerKind: Kind,
  model: z.string(),
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  profiles: z.array(z.string()),
  requests30d: z.number(),
  catalog: CatalogPriceSchema.nullable(),
});
export type MissingPrice = z.infer<typeof MissingPriceSchema>;

export const CatalogStatusSchema = z.object({
  sources: z.array(
    z.object({
      source: z.enum(['models.dev', 'litellm']),
      origin: z.enum(['database', 'vendored']),
      url: z.string(),
      homepage: z.string(),
      fetchedAt: z.string(),
      contentHash: z.string(),
      entries: z.number(),
      lastAttemptAt: z.string().nullable(),
      lastError: z.string().nullable(),
    }),
  ),
  refreshEnabled: z.boolean(),
  refreshIntervalHours: z.number(),
});
export type CatalogStatus = z.infer<typeof CatalogStatusSchema>;

const CatalogRefreshSchema = z.object({
  refreshedAt: z.string(),
  sources: z.array(z.object({ source: z.string(), ok: z.boolean(), changed: z.boolean(), entries: z.number().nullable(), error: z.string().nullable() })),
  prices: z.object({ updated: z.number(), unchanged: z.number(), notInCatalog: z.number() }),
});
export type CatalogRefreshResult = z.infer<typeof CatalogRefreshSchema>;

/** Listing the provider's models can take a few seconds (paginated cloud APIs; 15 s adapter deadline). */
export const listProviderModels = (id: string, refresh = false) =>
  api.get(`/v1/model-providers/${id}/models${refresh ? '?refresh=true' : ''}`, ModelListSchema, { timeoutMs: 45_000 });

export const listMissingPrices = () => api.get('/v1/model-pricing/missing', z.array(MissingPriceSchema));
export const addCatalogPrice = (input: { providerKind: ProviderKind; model: string; providerId?: string }) =>
  api.post('/v1/model-pricing/from-catalog', input, PricingSchema);
export const getCatalogStatus = () => api.get('/v1/model-catalog', CatalogStatusSchema);
/** Downloads both catalogs (~8 MB) on the API: allow two minutes. */
export const refreshCatalog = () => api.post('/v1/model-catalog/refresh', {}, CatalogRefreshSchema, { timeoutMs: 120_000 });
