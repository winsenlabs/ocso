import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { validation } from '@ocso/domain';
import { z } from 'zod';
import { liteLlmKey, modelsDevKey } from '../../catalog/mapping.js';
import { createAiSdkAdapter } from '../../core/adapter.js';
import { listBedrockModels, type BedrockAuth } from '../../discovery/bedrock.js';
import { listContext } from '../../discovery/context.js';
import {
  commonSettingsShape,
  parseProviderConfig,
  secretValues,
  withOverrides,
  type ProviderDefinition,
} from '../definition.js';
import { bedrockCachePlan, MAX_EXPLICIT_BREAKPOINTS } from '../shared/cache-plans.js';
import { describePromptCaching } from '../shared/caching-description.js';
import { fetchOption, keepOnlyReportedCounters } from '../shared/sdk-helpers.js';
import { bedrockAuthOptions } from './credentials.js';
import { bedrockCapabilities, bedrockSupportsLongCacheTtl } from './models.js';

/**
 * AWS Bedrock via the Converse / ConverseStream API (`createAmazonBedrock`).
 * `bedrock.cachePoint` after the compiler breakpoints (max 4) for Claude and
 * Nova; a system cachePoint also covers the tool definitions. Tools are
 * always resent: Bedrock strips tool history when a request has no tools.
 */

const settingsSchema = z.object({
  /** AWS region, e.g. ap-south-1. Falls back to the provider record's region. */
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/).optional(),
  authMode: z.enum(['ACCESS_KEYS', 'IAM_ROLE', 'API_KEY']).default('ACCESS_KEYS'),
  /** VPC interface endpoint or proxy for bedrock-runtime. */
  baseURL: z.url({ protocol: /^https$/ }).optional(),
  ...commonSettingsShape,
});
const credentialsSchema = z.object({
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
  sessionToken: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

export type BedrockSettings = z.infer<typeof settingsSchema>;
type BedrockCredentialFields = z.infer<typeof credentialsSchema>;

export const bedrockProvider: ProviderDefinition<BedrockSettings, BedrockCredentialFields> = {
  kind: 'BEDROCK',
  label: 'AWS Bedrock',
  mark: 'AWS',
  cachingSummary: 'cachePoint breakpoints (Claude, Nova)',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  // Model or system inference-profile ids, unchanged: region prefixes (`us.`, `eu.`, `global.`…) are
  // priced separately by the catalogs, so they are never stripped. Application inference-profile ARNs
  // say nothing about the model, so they are not priced.
  catalog: {
    providers: { 'models.dev': ['amazon-bedrock'], litellm: ['bedrock_converse', 'bedrock'] },
    listingProvider: 'amazon-bedrock',
    candidates: (model) =>
      model.startsWith('arn:') ? [] : [modelsDevKey('amazon-bedrock', model), liteLlmKey('bedrock_converse', model), liteLlmKey('bedrock', model)],
  },
  capabilities: (model, settings) => withOverrides(bedrockCapabilities(model), model, settings.capabilityOverrides),
  providerOptions: (model, request, settings) =>
    bedrockProvider.capabilities(model, settings).promptCaching === 'EXPLICIT'
      ? bedrockCachePlan(request, bedrockSupportsLongCacheTtl(model))
      : {},
  describeCaching: (model, settings) =>
    describePromptCaching(bedrockProvider.capabilities(model, settings), {
      explicit: `explicit cachePoint breakpoints (≤ ${MAX_EXPLICIT_BREAKPOINTS})`,
      explicitLongTtl: bedrockSupportsLongCacheTtl(model) ? 'breakpoints · 1h TTL' : 'breakpoints · 5m TTL (1h needs Claude 4.5+)',
    }),
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(bedrockProvider, config);
    const region = settings.region ?? config.region;
    if (!region) throw validation('provider_settings_invalid', 'A Bedrock region is required', { issues: [{ path: 'region' }] });
    const auth = bedrockAuthOptions(settings.authMode, credentials);
    const bedrock = createAmazonBedrock({
      region,
      ...auth,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...fetchOption(deps),
    });
    const adapter = createAiSdkAdapter({
      kind: 'BEDROCK',
      providerId: config.id,
      region,
      media: deps.media,
      capabilities: (model) => bedrockProvider.capabilities(model, settings),
      languageModel: (model) => bedrock(model),
      providerOptions: (model, request) => bedrockProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['x-amzn-requestid', 'x-amz-request-id'],
      // Converse `usage` carries cacheRead/WriteInputTokens only when the model caches.
      adjustUsage: (usage) => {
        const raw = usage.raw as { cacheReadInputTokens?: unknown; cacheWriteInputTokens?: unknown } | undefined;
        return keepOnlyReportedCounters(usage, {
          cacheRead: typeof raw?.cacheReadInputTokens === 'number',
          cacheWrite: typeof raw?.cacheWriteInputTokens === 'number',
          reasoning: usage.outputTokenDetails.reasoningTokens !== undefined,
        });
      },
      healthModel: settings.healthModel ?? null,
      secrets: secretValues(config),
    });
    return { ...adapter, listModels: (options) => listBedrockModels(listContext(config, deps, options), listAuth(auth), region) };
  },
};

/** Control-plane auth from the same options the runtime client uses (API key bearer, or SigV4). */
function listAuth(auth: ReturnType<typeof bedrockAuthOptions>): BedrockAuth {
  if (auth.apiKey) return { mode: 'API_KEY', apiKey: auth.apiKey };
  const provider = auth.credentialProvider;
  if (provider) return { mode: 'SIGV4', credentials: async () => await provider() };
  const { accessKeyId = '', secretAccessKey = '', sessionToken } = auth;
  return { mode: 'SIGV4', credentials: async () => ({ accessKeyId, secretAccessKey, sessionToken }) };
}
