import { z } from 'zod';
import { firstPartyCatalogProviders } from '../registry.js';
import type { CatalogEntry, CatalogPrice, CatalogPriceTier } from './types.js';
import { opt, positiveInt, type InputKind } from './util.js';

/**
 * LiteLLM `model_prices_and_context_window.json` (MIT, BerriAI/litellm):
 * `{ [modelKey]: { litellm_provider, mode, input_cost_per_token, … } }` with
 * per-TOKEN USD costs and `supports_*` flags. Used only for models models.dev
 * lacks. Only chat/responses entries of the providers some provider definition
 * maps to are kept (`ProviderDefinition.catalog.providers.litellm`).
 */

const MODES = new Set(['chat', 'responses']);

const cost = z.number().finite().min(0);
const Entry = z
  .object({
    litellm_provider: z.string(),
    mode: z.string().optional(),
    input_cost_per_token: cost.optional(),
    output_cost_per_token: cost.optional(),
    cache_read_input_token_cost: cost.optional(),
    cache_creation_input_token_cost: cost.optional(),
    max_input_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
    supports_function_calling: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    supports_pdf_input: z.boolean().optional(),
    supports_audio_input: z.boolean().optional(),
  })
  .loose();
export const LiteLlmDocument = z.record(z.string(), z.unknown());

/** Per-token USD → per-1M-token USD, rounded to micro-dollars (removes float noise such as 3.9999999). */
export const perMillion = (perToken: number) => Math.round(perToken * 1e12) / 1e6;

const TIER_KEY = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/;
const FIELD: Readonly<Record<string, keyof Omit<CatalogPriceTier, 'aboveInputTokens'>>> = {
  input_cost_per_token: 'input',
  output_cost_per_token: 'output',
  cache_read_input_token_cost: 'cacheRead',
  cache_creation_input_token_cost: 'cacheWrite',
};

/** `input_cost_per_token_above_272k_tokens` & co. → tiers (only thresholds that price both input and output). */
function tiersOf(raw: Record<string, unknown>): CatalogPriceTier[] {
  const byThreshold = new Map<number, Partial<CatalogPriceTier>>();
  for (const [key, value] of Object.entries(raw)) {
    const m = TIER_KEY.exec(key);
    if (!m || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    const threshold = Number(m[2]) * 1000;
    const tier = byThreshold.get(threshold) ?? {};
    tier[FIELD[m[1]!]!] = perMillion(value);
    byThreshold.set(threshold, tier);
  }
  return [...byThreshold.entries()]
    .filter(([, t]) => t.input !== undefined && t.output !== undefined)
    .map(([aboveInputTokens, t]) => ({ aboveInputTokens, input: t.input!, output: t.output!, ...opt('cacheRead', t.cacheRead), ...opt('cacheWrite', t.cacheWrite) }))
    .sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
}

function priceOf(e: z.infer<typeof Entry>, raw: Record<string, unknown>): CatalogPrice | undefined {
  if (e.input_cost_per_token === undefined || e.output_cost_per_token === undefined) return undefined;
  const tiers = tiersOf(raw);
  return {
    input: perMillion(e.input_cost_per_token),
    output: perMillion(e.output_cost_per_token),
    ...opt('cacheRead', e.cache_read_input_token_cost === undefined ? undefined : perMillion(e.cache_read_input_token_cost)),
    ...opt('cacheWrite', e.cache_creation_input_token_cost === undefined ? undefined : perMillion(e.cache_creation_input_token_cost)),
    ...(tiers.length ? { tiers } : {}),
  };
}

export function normalizeLiteLlmEntry(key: string, raw: unknown, providers: ReadonlySet<string>): CatalogEntry | null {
  const parsed = Entry.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  if (!providers.has(e.litellm_provider) || !MODES.has(e.mode ?? '')) return null;
  const input: InputKind[] = ['text'];
  if (e.supports_vision) input.push('image');
  if (e.supports_pdf_input) input.push('pdf');
  if (e.supports_audio_input) input.push('audio');
  return {
    provider: e.litellm_provider,
    id: key,
    ...opt('contextWindow', positiveInt(e.max_input_tokens)),
    ...opt('maxOutput', positiveInt(e.max_output_tokens)),
    input,
    ...opt('toolCalling', e.supports_function_calling),
    ...opt('reasoning', e.supports_reasoning),
    ...opt('price', priceOf(e, raw as Record<string, unknown>)),
  };
}

/** Normalize the whole document. `sample_spec` and malformed entries are skipped. */
export function normalizeLiteLlm(document: unknown, providers: readonly string[] = firstPartyCatalogProviders('litellm')): CatalogEntry[] {
  const doc = LiteLlmDocument.parse(document);
  const keep = new Set(providers);
  const entries: CatalogEntry[] = [];
  for (const [key, raw] of Object.entries(doc)) {
    if (key === 'sample_spec') continue;
    const entry = normalizeLiteLlmEntry(key, raw, keep);
    if (entry) entries.push(entry);
  }
  return entries;
}
