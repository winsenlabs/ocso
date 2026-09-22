import type { AdapterDeps, ListModelsOptions, ProviderRuntimeConfig } from '../contract/types.js';
import type { ListContext } from './http.js';

/** Listing context for one provider configuration: the adapter's fetch, its secrets for scrubbing. */
export function listContext(
  config: ProviderRuntimeConfig,
  deps: AdapterDeps,
  options: ListModelsOptions | undefined,
  extraSecrets: readonly string[] = [],
): ListContext {
  return {
    kind: config.kind,
    providerId: config.id,
    fetch: deps.fetch ?? globalThis.fetch,
    secrets: [...Object.values(config.credentials), ...extraSecrets],
    abortSignal: options?.abortSignal,
  };
}
