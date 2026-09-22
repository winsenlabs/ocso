import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { validation } from '@ocso/domain';
import { z } from 'zod';
import { createAiSdkAdapter } from '../../core/adapter.js';
import {
  commonSettingsShape,
  parseProviderConfig,
  secretValues,
  withOverrides,
  type ProviderDefinition,
} from '../definition.js';
import { bedrockCachePlan } from '../shared/cache-plans.js';
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
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  capabilities: (model, settings) => withOverrides(bedrockCapabilities(model), model, settings.capabilityOverrides),
  providerOptions: (model, request, settings) =>
    bedrockProvider.capabilities(model, settings).promptCaching === 'EXPLICIT'
      ? bedrockCachePlan(request, bedrockSupportsLongCacheTtl(model))
      : {},
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(bedrockProvider, config);
    const region = settings.region ?? config.region;
    if (!region) throw validation('provider_settings_invalid', 'A Bedrock region is required', { issues: [{ path: 'region' }] });
    const bedrock = createAmazonBedrock({
      region,
      ...bedrockAuthOptions(settings.authMode, credentials),
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...fetchOption(deps),
    });
    return createAiSdkAdapter({
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
  },
};
