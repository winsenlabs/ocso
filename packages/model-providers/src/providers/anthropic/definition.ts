import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { createAiSdkAdapter } from '../../core/adapter.js';
import {
  commonSettingsShape,
  parseProviderConfig,
  requiredSecret,
  secretValues,
  withOverrides,
  type ProviderDefinition,
} from '../definition.js';
import { anthropicCachePlan } from '../shared/cache-plans.js';
import { claudeCapabilities } from '../shared/model-families.js';
import { fetchOption } from '../shared/sdk-helpers.js';

/**
 * Anthropic API (`@ai-sdk/anthropic`). Explicit `cacheControl` breakpoints
 * (≤ 4) at the compiler's AGENT_PREFIX / CONVERSATION_CONTEXT / HISTORY
 * sites; `ttl: '1h'` when the request asks for it (research/01 §4).
 */

const settingsSchema = z.object({
  /** Override for proxies/gateways; default https://api.anthropic.com/v1. */
  baseURL: z.url({ protocol: /^https$/ }).optional(),
  ...commonSettingsShape,
});
const credentialsSchema = z.object({ apiKey: requiredSecret('Anthropic API key') });

export type AnthropicSettings = z.infer<typeof settingsSchema>;
type AnthropicCredentials = z.infer<typeof credentialsSchema>;

const DEFAULT_HEALTH_MODEL = 'claude-haiku-4-5';

export const anthropicProvider: ProviderDefinition<AnthropicSettings, AnthropicCredentials> = {
  kind: 'ANTHROPIC',
  label: 'Anthropic API',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  capabilities: (model, settings) => withOverrides(claudeCapabilities(model), model, settings.capabilityOverrides),
  providerOptions: (_model, request) => anthropicCachePlan(request),
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(anthropicProvider, config);
    const anthropic = createAnthropic({
      apiKey: credentials.apiKey,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...fetchOption(deps),
    });
    return createAiSdkAdapter({
      kind: 'ANTHROPIC',
      providerId: config.id,
      region: config.region,
      media: deps.media,
      capabilities: (model) => anthropicProvider.capabilities(model, settings),
      languageModel: (model) => anthropic(model),
      providerOptions: (model, request) => anthropicProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['request-id', 'x-request-id'],
      healthModel: settings.healthModel ?? DEFAULT_HEALTH_MODEL,
      secrets: secretValues(config),
    });
  },
};
