import type { CatalogSource } from './types.js';

/**
 * One catalog key to look a model up by (research/09 §6). The catalogs spell
 * ids differently from the provider APIs, so each provider definition maps
 * its own model ids to keys (`ProviderDefinition.catalog`); nothing here names
 * a provider kind. Keys must match exactly: no family guessing, and an
 * ambiguous id maps to no key (the model is then not priced).
 */
export interface CatalogCandidate {
  source: CatalogSource;
  /** models.dev provider id, or LiteLLM `litellm_provider`. */
  provider: string;
  id: string;
}

/** A models.dev key (`https://models.dev/api.json` → provider → models → id). */
export const modelsDevKey = (provider: string, id: string): CatalogCandidate => ({ source: 'models.dev', provider, id });

/** A LiteLLM key (`model_prices_and_context_window.json` entry id, with its `litellm_provider`). */
export const liteLlmKey = (provider: string, id: string): CatalogCandidate => ({ source: 'litellm', provider, id });
