import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { liteLlmKey, modelsDevKey } from '../../catalog/mapping.js';
import { createAiSdkAdapter } from '../../core/adapter.js';
import { listOpenAiModels } from '../../discovery/openai.js';
import { listContext } from '../../discovery/context.js';
import {
  commonSettingsShape,
  parseProviderConfig,
  requiredSecret,
  secretValues,
  withOverrides,
  type ProviderDefinition,
} from '../definition.js';
import { openAiFamilyPlan } from '../shared/cache-plans.js';
import { keyBasedCaching } from '../shared/caching-description.js';
import { openAiCapabilities, usesOpenAiCacheBreakpoints } from '../shared/model-families.js';
import { fetchOption } from '../shared/sdk-helpers.js';

/**
 * OpenAI API through the Responses API (`openai(model)`). Caching is
 * automatic; OCSO steers routing with `promptCacheKey` (request.cache.key),
 * asks for 24h retention before GPT-5.6, and places explicit breakpoints on
 * 5.6+. `store: false` by default for data minimization.
 */

const settingsSchema = z.object({
  baseURL: z.url({ protocol: /^https$/ }).optional(),
  organization: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  /** Keep responses on OpenAI's side (`store: true`). Default false. */
  storeResponses: z.boolean().default(false),
  /** Force explicit cache breakpoints on/off; default: by model id (GPT-5.6+). */
  explicitCacheBreakpoints: z.boolean().optional(),
  ...commonSettingsShape,
});
const credentialsSchema = z.object({ apiKey: requiredSecret('OpenAI API key') });

export type OpenAiSettings = z.infer<typeof settingsSchema>;
type OpenAiCredentials = z.infer<typeof credentialsSchema>;

const explicitBreakpoints = (model: string, settings: OpenAiSettings) =>
  settings.explicitCacheBreakpoints ?? usesOpenAiCacheBreakpoints(model);

export const openAiProvider: ProviderDefinition<OpenAiSettings, OpenAiCredentials> = {
  kind: 'OPENAI',
  label: 'OpenAI API',
  mark: 'OAI',
  cachingSummary: 'automatic · prompt cache key',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  // The API model id, unchanged: a dated snapshot is priced only when the catalog lists that exact id.
  catalog: {
    providers: { 'models.dev': ['openai'], litellm: ['openai'] },
    listingProvider: 'openai',
    candidates: (model) => [modelsDevKey('openai', model), liteLlmKey('openai', model)],
  },
  capabilities: (model, settings) =>
    withOverrides(openAiCapabilities(model, explicitBreakpoints(model, settings)), model, settings.capabilityOverrides),
  providerOptions: (model, request, settings) =>
    openAiFamilyPlan(request, {
      key: 'openai',
      explicitBreakpoints: explicitBreakpoints(model, settings),
      store: settings.storeResponses,
    }),
  describeCaching: (model, settings) => keyBasedCaching(openAiProvider.capabilities(model, settings), explicitBreakpoints(model, settings)),
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(openAiProvider, config);
    const openai = createOpenAI({
      apiKey: credentials.apiKey,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(settings.organization ? { organization: settings.organization } : {}),
      ...(settings.project ? { project: settings.project } : {}),
      ...fetchOption(deps),
    });
    const adapter = createAiSdkAdapter({
      kind: 'OPENAI',
      providerId: config.id,
      region: config.region,
      media: deps.media,
      capabilities: (model) => openAiProvider.capabilities(model, settings),
      languageModel: (model) => openai(model),
      providerOptions: (model, request) => openAiProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['x-request-id'],
      healthModel: settings.healthModel ?? null,
      // The Responses API rejects max_output_tokens below 16.
      healthProbe: { maxOutputTokens: 16 },
      secrets: secretValues(config),
    });
    return {
      ...adapter,
      listModels: (options) => listOpenAiModels(listContext(config, deps, options), credentials.apiKey, settings),
    };
  },
};
