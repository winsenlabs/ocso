import type { ProviderKind } from '../contract/types.js';
import type { CatalogSource } from './types.js';

/**
 * OCSO provider kind + model id → catalog keys (research/09 §6). Explicit per
 * kind because the catalogs spell ids differently from the provider APIs:
 *
 * - OPENAI / ANTHROPIC: the API model id, unchanged (dated snapshots only
 *   match when the catalog lists that exact dated id).
 * - BEDROCK: the model or system inference-profile id, unchanged — region
 *   prefixes (`us.`, `eu.`, `global.`…) are priced separately by the
 *   catalogs, so they are never stripped. Application inference-profile ARNs
 *   say nothing about the model → no price.
 * - VERTEX: Gemini ids unchanged. Claude ids: models.dev spells the dateless
 *   (4.6+) ids with `@default` (`claude-opus-5` → `claude-opus-5@default`);
 *   dated ids keep their `@YYYYMMDD`. LiteLLM prefixes `vertex_ai/`.
 * - FOUNDRY: the deployment's declared underlying model (settings
 *   `deployments[name].model`), else the deployment name — Foundry names
 *   deployments after the model by default. models.dev `azure`; LiteLLM
 *   `azure/…` and `azure_ai/…`.
 * - SARVAM: models.dev `sarvam`. DEV_SCRIPTED: never priced.
 */

export interface CatalogCandidate {
  source: CatalogSource;
  provider: string;
  id: string;
}

const md = (provider: string, id: string): CatalogCandidate => ({ source: 'models.dev', provider, id });
const ll = (provider: string, id: string): CatalogCandidate => ({ source: 'litellm', provider, id });

const isClaude = (model: string) => /^claude-/i.test(model);

export function catalogCandidates(kind: ProviderKind, model: string, baseModel?: string | null): CatalogCandidate[] {
  const id = model.trim();
  if (!id) return [];
  switch (kind) {
    case 'OPENAI':
      return [md('openai', id), ll('openai', id)];
    case 'ANTHROPIC':
      return [md('anthropic', id), ll('anthropic', id)];
    case 'BEDROCK':
      if (id.startsWith('arn:')) return [];
      return [md('amazon-bedrock', id), ll('bedrock_converse', id), ll('bedrock', id)];
    case 'VERTEX': {
      if (isClaude(id)) {
        const versioned = id.includes('@') ? id : `${id}@default`;
        return [md('google-vertex-anthropic', versioned), md('google-vertex', versioned), ll('vertex_ai-anthropic_models', `vertex_ai/${id}`)];
      }
      return [md('google-vertex', id), ll('vertex_ai-language-models', id), ll('vertex_ai-language-models', `vertex_ai/${id}`)];
    }
    case 'FOUNDRY': {
      const base = baseModel?.trim() || id;
      return [md('azure', base), ll('azure', `azure/${base}`), ll('azure_ai', `azure_ai/${base}`)];
    }
    case 'SARVAM':
      return [md('sarvam', id)];
    case 'DEV_SCRIPTED':
      return [];
  }
}

/** The models.dev provider whose model list stands in when a provider has no listing endpoint. */
export const PRIMARY_CATALOG_PROVIDER: Readonly<Partial<Record<ProviderKind, string>>> = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  BEDROCK: 'amazon-bedrock',
  SARVAM: 'sarvam',
};
