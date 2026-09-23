import { createGoogleVertex, type GoogleVertexProviderSettings } from '@ai-sdk/google-vertex';
import { createGoogleVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { validation } from '@ocso/domain';
import { z } from 'zod';
import { liteLlmKey, modelsDevKey, type CatalogCandidate } from '../../catalog/mapping.js';
import { createAiSdkAdapter } from '../../core/adapter.js';
import { listContext } from '../../discovery/context.js';
import { listVertexModels } from '../../discovery/vertex.js';
import {
  commonSettingsShape,
  parseProviderConfig,
  secretValues,
  withOverrides,
  type ProviderDefinition,
} from '../definition.js';
import { anthropicCachePlan } from '../shared/cache-plans.js';
import { CACHE_CONTROL_WORDING, describePromptCaching } from '../shared/caching-description.js';
import { claudeCapabilities, geminiCapabilities, isClaudeModel } from '../shared/model-families.js';
import { fetchOption } from '../shared/sdk-helpers.js';
import { createAdcTokenProvider, createServiceAccountTokenProvider, parseServiceAccountKey } from './service-account.js';

/**
 * Google Vertex AI. Gemini via `createGoogleVertex` with IMPLICIT caching
 * only (stable prefix; explicit `cachedContent` is not used because the SDK
 * also sends systemInstruction/tools, which the API rejects). Claude model
 * ids route to `createGoogleVertexAnthropic` with `anthropic.cacheControl`.
 */

const settingsSchema = z.object({
  /** GCP project id; defaults to the service account key's project_id. */
  project: z.string().min(1).optional(),
  /** `global`, a multi-region (`us`, `eu`) or a region (`asia-south1`). Falls back to the record's region, then `global`. */
  location: z.string().regex(/^[a-z0-9-]+$/).optional(),
  authMode: z.enum(['SERVICE_ACCOUNT_KEY', 'APPLICATION_DEFAULT']).default('SERVICE_ACCOUNT_KEY'),
  ...commonSettingsShape,
});
const credentialsSchema = z.object({
  /** Full JSON of a service-account key file (SERVICE_ACCOUNT_KEY mode). */
  serviceAccountJson: z.string().min(1).optional(),
});

export type VertexSettings = z.infer<typeof settingsSchema>;
type VertexCredentials = z.infer<typeof credentialsSchema>;

type GoogleAuthClient = NonNullable<NonNullable<GoogleVertexProviderSettings['googleAuthOptions']>['authClient']>;

interface VertexAuth {
  project: string | undefined;
  /** Bearer token source; undefined = google-auth-library Application Default Credentials. */
  token: (() => Promise<string>) | undefined;
  /** Key material to scrub from errors in addition to the raw credential JSON. */
  secrets: string[];
}

function resolveAuth(settings: VertexSettings, creds: VertexCredentials, fetchImpl: typeof fetch | undefined): VertexAuth {
  if (settings.authMode === 'APPLICATION_DEFAULT') return { project: settings.project, token: undefined, secrets: [] };
  if (!creds.serviceAccountJson) {
    throw validation('provider_credentials_invalid', 'A Google service account key is required', {
      fields: ['serviceAccountJson'],
    });
  }
  const key = parseServiceAccountKey(creds.serviceAccountJson);
  return {
    project: settings.project ?? key.project_id,
    token: createServiceAccountTokenProvider(key, fetchImpl),
    secrets: [key.private_key, ...(key.private_key_id ? [key.private_key_id] : [])],
  };
}

/**
 * Gemini ids unchanged. Claude: models.dev spells the dateless (4.6+) ids with
 * `@default` (`claude-opus-5` → `claude-opus-5@default`); dated ids keep their
 * `@YYYYMMDD`. LiteLLM prefixes `vertex_ai/`.
 */
function vertexCatalogCandidates(model: string): CatalogCandidate[] {
  if (/^claude-/i.test(model)) {
    const versioned = model.includes('@') ? model : `${model}@default`;
    return [
      modelsDevKey('google-vertex-anthropic', versioned),
      modelsDevKey('google-vertex', versioned),
      liteLlmKey('vertex_ai-anthropic_models', `vertex_ai/${model}`),
    ];
  }
  return [modelsDevKey('google-vertex', model), liteLlmKey('vertex_ai-language-models', model), liteLlmKey('vertex_ai-language-models', `vertex_ai/${model}`)];
}

export const vertexProvider: ProviderDefinition<VertexSettings, VertexCredentials> = {
  kind: 'VERTEX',
  label: 'Google Vertex AI',
  mark: 'GCP',
  cachingSummary: 'implicit prefix (Gemini) · cache_control (Claude)',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  catalog: {
    providers: { 'models.dev': ['google-vertex-anthropic', 'google-vertex'], litellm: ['vertex_ai-anthropic_models', 'vertex_ai-language-models'] },
    candidates: vertexCatalogCandidates,
  },
  capabilities: (model, settings) =>
    withOverrides(isClaudeModel(model) ? claudeCapabilities(model) : geminiCapabilities(model), model, settings.capabilityOverrides),
  // Gemini: implicit caching only, so no directives at all.
  providerOptions: (model, request) => (isClaudeModel(model) ? anthropicCachePlan(request) : {}),
  describeCaching: (model, settings) =>
    describePromptCaching(vertexProvider.capabilities(model, settings), { ...CACHE_CONTROL_WORDING, automatic: 'implicit prefix caching (stable prefix first)' }),
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(vertexProvider, config);
    const auth = resolveAuth(settings, credentials, deps.fetch);
    if (!auth.project) throw validation('provider_settings_invalid', 'A GCP project id is required', { issues: [{ path: 'project' }] });
    const location = settings.location ?? config.region ?? 'global';
    const token = auth.token;
    // google-auth-library only calls getAccessToken() on a supplied authClient.
    const authClient = token ? ({ getAccessToken: async () => ({ token: await token() }) } as unknown as GoogleAuthClient) : undefined;
    const gemini = createGoogleVertex({
      // '' pins OAuth: an ambient GOOGLE_VERTEX_API_KEY would otherwise switch to express mode.
      apiKey: '',
      project: auth.project,
      location,
      ...(authClient ? { googleAuthOptions: { authClient } } : {}),
      ...fetchOption(deps),
    });
    const claude = createGoogleVertexAnthropic({
      project: auth.project,
      location,
      ...(token ? { generateAuthToken: token } : {}),
      ...fetchOption(deps),
    });
    const adapter = createAiSdkAdapter({
      kind: 'VERTEX',
      providerId: config.id,
      region: location,
      media: deps.media,
      capabilities: (model) => vertexProvider.capabilities(model, settings),
      languageModel: (model) => (isClaudeModel(model) ? claude(model) : gemini(model)),
      providerOptions: (model, request) => vertexProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['x-request-id', 'request-id'],
      healthModel: settings.healthModel ?? null,
      secrets: [...secretValues(config), ...auth.secrets],
    });
    const project = auth.project;
    const listToken = token ?? createAdcTokenProvider();
    return {
      ...adapter,
      listModels: (options) => listVertexModels(listContext(config, deps, options, auth.secrets), { project, location, token: listToken }),
    };
  },
};
