import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { validation } from '@ocso/domain';
import type { ModelRequest, ProviderModelInfo } from '../../contract/types.js';
import { createAiSdkAdapter } from '../../core/adapter.js';
import type { ProviderOptionsPlan } from '../../core/spec.js';
import { parseProviderConfig, secretValues, type ProviderDefinition } from '../definition.js';
import { anthropicCachePlan, openAiFamilyPlan } from '../shared/cache-plans.js';
import { fetchOption, openAiCompatibleUsage } from '../shared/sdk-helpers.js';
import { AZURE_AI_SCOPE, AZURE_OPENAI_SCOPE, bearerFetch, entraTokenProvider } from './entra.js';
import {
  foundryBaseUrls,
  foundryCapabilities,
  foundryCredentialsSchema,
  foundrySettingsSchema,
  resolveDeployment,
  type FoundryCredentials,
  type FoundrySettings,
} from './settings.js';

/**
 * Microsoft Foundry. No official AI SDK package exists (research/01):
 * OpenAI-family deployments use `@ai-sdk/azure` against `…/openai/v1`
 * (Responses API by default, `azure.promptCacheKey`); Claude deployments use
 * `@ai-sdk/anthropic` against `…/anthropic/v1` (`cacheControl`); other
 * deployments (DeepSeek, Llama, Grok…) use Chat Completions without cache
 * directives. Auth: API key, or Entra ID bearer tokens.
 */

function foundryProviderOptions(deployment: string, request: ModelRequest, settings: FoundrySettings): ProviderOptionsPlan {
  const d = resolveDeployment(deployment, settings);
  if (d.family === 'anthropic') return anthropicCachePlan(request);
  if (d.family === 'other') return {};
  const responses = d.api === 'RESPONSES';
  return openAiFamilyPlan(request, {
    // azure.chat() reads the `openai` key; the Responses model reads `azure`.
    key: responses ? 'azure' : 'openai',
    explicitBreakpoints: d.explicitCacheBreakpoints,
    store: responses ? settings.storeResponses : undefined,
  });
}

function clients(settings: FoundrySettings, creds: FoundryCredentials, fetchImpl: typeof fetch | undefined) {
  const urls = foundryBaseUrls(settings);
  const fetchOpt = fetchImpl ? { fetch: fetchImpl } : {};
  if (settings.authMode === 'API_KEY') {
    if (!creds.apiKey) throw validation('provider_credentials_invalid', 'A Foundry API key is required', { fields: ['apiKey'] });
    return {
      azure: createAzure({ baseURL: urls.openai, apiKey: creds.apiKey, ...fetchOpt }),
      claude: createAnthropic({ baseURL: urls.anthropic, apiKey: creds.apiKey, ...fetchOpt }),
    };
  }
  return {
    azure: createAzure({ baseURL: urls.openai, tokenProvider: entraTokenProvider(creds, AZURE_OPENAI_SCOPE), ...fetchOpt }),
    // authToken is a placeholder: bearerFetch replaces the header with a fresh Entra token per request.
    claude: createAnthropic({
      baseURL: urls.anthropic,
      authToken: 'entra-id',
      fetch: bearerFetch(entraTokenProvider(creds, AZURE_AI_SCOPE), fetchImpl),
    }),
  };
}

/**
 * Foundry "listing" = the deployments configured in the provider settings
 * (listing deployments needs Azure control-plane access, which an inference
 * key does not grant). `baseModel` is the declared underlying model.
 */
export function foundryDeployments(settings: FoundrySettings): ProviderModelInfo[] {
  return Object.entries(settings.deployments).map(([name, d]) => ({
    id: name,
    displayName: d.model ? `${name} (${d.model})` : name,
    createdAt: null,
    ownedBy: d.modelFamily,
    kind: 'deployment' as const,
    ...(d.model ? { baseModel: d.model } : {}),
  }));
}

export const foundryProvider: ProviderDefinition<FoundrySettings, FoundryCredentials> = {
  kind: 'FOUNDRY',
  label: 'Microsoft Foundry',
  devOnly: false,
  settingsSchema: foundrySettingsSchema,
  credentialsSchema: foundryCredentialsSchema,
  capabilities: (deployment, settings) => foundryCapabilities(deployment, settings),
  providerOptions: foundryProviderOptions,
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(foundryProvider, config);
    const { azure, claude } = clients(settings, credentials, fetchOption(deps).fetch);
    const adapter = createAiSdkAdapter({
      kind: 'FOUNDRY',
      providerId: config.id,
      region: config.region,
      media: deps.media,
      capabilities: (deployment) => foundryProvider.capabilities(deployment, settings),
      languageModel: (deployment) => {
        const d = resolveDeployment(deployment, settings);
        if (d.family === 'anthropic') return claude(deployment);
        return d.api === 'RESPONSES' ? azure(deployment) : azure.chat(deployment);
      },
      providerOptions: (deployment, request) => foundryProvider.providerOptions(deployment, request, settings),
      requestIdHeaders: ['apim-request-id', 'x-request-id', 'request-id'],
      adjustUsage: (usage, deployment) =>
        resolveDeployment(deployment, settings).family === 'other' ? openAiCompatibleUsage(usage) : usage,
      healthModel: settings.healthModel ?? null,
      healthProbe: { maxOutputTokens: 16 },
      secrets: secretValues(config),
    });
    return { ...adapter, listModels: async () => foundryDeployments(settings) };
  },
};
