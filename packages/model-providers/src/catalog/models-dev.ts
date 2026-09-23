import { z } from 'zod';
import { firstPartyCatalogProviders } from '../registry.js';
import type { CatalogEntry, CatalogPrice, CatalogPriceTier } from './types.js';
import { isInputKind, opt, positiveInt } from './util.js';

/**
 * models.dev `api.json` (MIT, github.com/sst/models.dev): `{ [providerId]:
 * { id, name, models: { [modelId]: { name, cost, limit, modalities,
 * tool_call, reasoning, status, … } } } }`, costs in USD per 1M tokens.
 * Only the providers some provider definition maps to are kept
 * (`ProviderDefinition.catalog.providers['models.dev']`).
 */

const price = z.number().finite().min(0);
const Tier = z
  .object({
    input: price.optional(),
    output: price.optional(),
    cache_read: price.optional(),
    cache_write: price.optional(),
    tier: z.object({ type: z.string(), size: z.number().int().positive() }).loose().optional(),
  })
  .loose();
const Cost = z
  .object({
    input: price.optional(),
    output: price.optional(),
    cache_read: price.optional(),
    cache_write: price.optional(),
    tiers: z.array(Tier).optional(),
    context_over_200k: Tier.optional(),
  })
  .loose();
const Model = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    tool_call: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    status: z.string().optional(),
    modalities: z.object({ input: z.array(z.string()).optional() }).loose().optional(),
    limit: z.object({ context: z.number().optional(), output: z.number().optional() }).loose().optional(),
    cost: Cost.optional(),
  })
  .loose();
const Provider = z.object({ models: z.record(z.string(), z.unknown()) }).loose();
export const ModelsDevDocument = z.record(z.string(), z.unknown());

/** models.dev tier sizes are either the threshold (272000) or threshold + 1 (272001). */
export const tierThreshold = (size: number) => (size % 1000 === 1 ? size - 1 : size);

function toTier(t: z.infer<typeof Tier>, aboveInputTokens: number): CatalogPriceTier | null {
  if (t.input === undefined || t.output === undefined) return null;
  return { aboveInputTokens, input: t.input, output: t.output, ...opt('cacheRead', t.cache_read), ...opt('cacheWrite', t.cache_write) };
}

function toPrice(cost: z.infer<typeof Cost> | undefined): CatalogPrice | undefined {
  if (!cost || cost.input === undefined || cost.output === undefined) return undefined;
  const tiers = (cost.tiers ?? [])
    .filter((t) => t.tier?.type === 'context')
    .map((t) => toTier(t, tierThreshold(t.tier!.size)))
    .filter((t): t is CatalogPriceTier => t !== null);
  if (!tiers.length && cost.context_over_200k) {
    const t = toTier(cost.context_over_200k, 200_000);
    if (t) tiers.push(t);
  }
  tiers.sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
  return {
    input: cost.input,
    output: cost.output,
    ...opt('cacheRead', cost.cache_read),
    ...opt('cacheWrite', cost.cache_write),
    ...(tiers.length ? { tiers } : {}),
  };
}

export function normalizeModelsDevModel(provider: string, key: string, raw: unknown): CatalogEntry | null {
  const parsed = Model.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const input = m.modalities?.input?.filter(isInputKind);
  return {
    provider,
    id: key,
    ...opt('name', m.name),
    ...opt('contextWindow', positiveInt(m.limit?.context)),
    ...opt('maxOutput', positiveInt(m.limit?.output)),
    ...(input?.length ? { input } : {}),
    ...opt('toolCalling', m.tool_call),
    ...opt('reasoning', m.reasoning),
    ...(m.status === 'deprecated' ? { deprecated: true } : {}),
    ...opt('price', toPrice(m.cost)),
  };
}

/** Normalize a parsed api.json document. Malformed models are skipped, never fatal. */
export function normalizeModelsDev(document: unknown, providers: readonly string[] = firstPartyCatalogProviders('models.dev')): CatalogEntry[] {
  const doc = ModelsDevDocument.parse(document);
  const entries: CatalogEntry[] = [];
  for (const provider of providers) {
    const p = Provider.safeParse(doc[provider]);
    if (!p.success) continue;
    for (const [key, model] of Object.entries(p.data.models)) {
      const entry = normalizeModelsDevModel(provider, key, model);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}
