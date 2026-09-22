import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { JSONObject } from '@ai-sdk/provider';
import { z } from 'zod';
import type { ModelCapabilities, ModelRequest } from '../../contract/types.js';
import { createAiSdkAdapter } from '../../core/adapter.js';
import type { ProviderOptionsPlan } from '../../core/spec.js';
import {
  commonSettingsShape,
  parseProviderConfig,
  requiredSecret,
  secretValues,
  withOverrides,
  type ProviderDefinition,
} from '../definition.js';
import { fetchOption, openAiCompatibleUsage } from '../shared/sdk-helpers.js';

/**
 * Sarvam (OpenAI-compatible Chat Completions, research/01 §6). Uses
 * `createOpenAICompatible` rather than `sarvam-ai-sdk`, which drops streamed
 * usage. No cache controls exist; promptCaching is UNVERIFIED and cached
 * tokens are reported only if Sarvam sends `prompt_tokens_details`.
 *
 * Reasoning (`reasoning_effort` accepts low | high | max; null disables):
 *   none → null (thinking off), low → 'low', medium → provider default
 *   (field omitted), high → 'high'.
 */

const settingsSchema = z.object({
  baseURL: z.url({ protocol: /^https$/ }).default('https://api.sarvam.ai/v1'),
  ...commonSettingsShape,
});
const credentialsSchema = z.object({ apiKey: requiredSecret('Sarvam API subscription key') });

export type SarvamSettings = z.infer<typeof settingsSchema>;
type SarvamCredentials = z.infer<typeof credentialsSchema>;

const DEFAULT_HEALTH_MODEL = 'sarvam-105b';

function sarvamCapabilities(): ModelCapabilities {
  return {
    imageInput: false,
    fileInput: false,
    audioInput: false,
    toolCalling: true,
    structuredOutput: false,
    reasoning: true,
    streaming: true,
    promptCaching: 'UNVERIFIED',
    reportsCacheWrites: false,
  };
}

function sarvamProviderOptions(request: ModelRequest): ProviderOptionsPlan {
  const effort: Partial<Record<NonNullable<ModelRequest['reasoning']>, string>> = { low: 'low', high: 'high' };
  const value = request.reasoning ? effort[request.reasoning] : undefined;
  const sarvam: JSONObject | undefined = value ? { reasoningEffort: value } : undefined;
  // Never cache directives: Sarvam documents none (ADR-006).
  return { portableReasoning: false, ...(sarvam ? { request: { sarvam } } : {}) };
}

export const sarvamProvider: ProviderDefinition<SarvamSettings, SarvamCredentials> = {
  kind: 'SARVAM',
  label: 'Sarvam AI',
  devOnly: false,
  settingsSchema,
  credentialsSchema,
  capabilities: (model, settings) => withOverrides(sarvamCapabilities(), model, settings.capabilityOverrides),
  providerOptions: (_model, request) => sarvamProviderOptions(request),
  create(config, deps) {
    const { settings, credentials } = parseProviderConfig(sarvamProvider, config);
    const base = {
      name: 'sarvam',
      baseURL: settings.baseURL,
      apiKey: credentials.apiKey,
      headers: { 'api-subscription-key': credentials.apiKey },
      includeUsage: true,
      ...fetchOption(deps),
    };
    const sarvam = createOpenAICompatible(base);
    // Thinking is on by default at Sarvam; `reasoning: 'none'` must send an explicit null.
    const sarvamNoThinking = createOpenAICompatible({
      ...base,
      transformRequestBody: (body: Record<string, unknown>) => ({ ...body, reasoning_effort: null }),
    });
    return createAiSdkAdapter({
      kind: 'SARVAM',
      providerId: config.id,
      region: config.region,
      media: deps.media,
      capabilities: (model) => sarvamProvider.capabilities(model, settings),
      languageModel: (model, request) =>
        (request.reasoning === 'none' ? sarvamNoThinking : sarvam).chatModel(model),
      providerOptions: (model, request) => sarvamProvider.providerOptions(model, request, settings),
      requestIdHeaders: ['x-request-id', 'request-id'],
      adjustUsage: (usage) => openAiCompatibleUsage(usage),
      healthModel: settings.healthModel ?? DEFAULT_HEALTH_MODEL,
      // Thinking would consume the 1-token budget.
      healthProbe: { maxOutputTokens: 1, reasoning: 'none' },
      secrets: secretValues(config),
    });
  },
};
