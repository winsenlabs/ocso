import { z } from 'zod';
import type { ModelCapabilities } from '../../contract/types.js';
import { commonSettingsShape, withOverrides } from '../definition.js';
import {
  claudeCapabilities,
  genericChatCapabilities,
  openAiCapabilities,
  usesOpenAiCacheBreakpoints,
} from '../shared/model-families.js';

/**
 * Microsoft Foundry settings. The model id OCSO passes is the DEPLOYMENT
 * name; each deployment declares its model family because the name alone
 * says nothing about the model behind it.
 */

const deploymentSchema = z.object({
  modelFamily: z.enum(['openai', 'anthropic', 'other']),
  /** Underlying model name (e.g. gpt-5.5, claude-sonnet-4-6) for capability heuristics. */
  model: z.string().min(1).optional(),
  /** OpenAI family only: Responses API (default) or Chat Completions. */
  api: z.enum(['RESPONSES', 'CHAT_COMPLETIONS']).default('RESPONSES'),
  /** OpenAI family only: force GPT-5.6+ explicit cache breakpoints on/off. */
  explicitCacheBreakpoints: z.boolean().optional(),
});

export const foundrySettingsSchema = z
  .object({
    /** Foundry resource name → https://<resourceName>.services.ai.azure.com */
    resourceName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/i).optional(),
    /** Alternative to resourceName: resource or project endpoint URL (https). */
    endpoint: z.url({ protocol: /^https$/ }).optional(),
    authMode: z.enum(['API_KEY', 'ENTRA_ID']).default('API_KEY'),
    deployments: z.record(z.string().min(1), deploymentSchema).default({}),
    /** Family assumed for deployments not listed above. */
    defaultModelFamily: z.enum(['openai', 'anthropic', 'other']).default('openai'),
    /** Keep Responses API responses on the service side (`store: true`). Default false. */
    storeResponses: z.boolean().default(false),
    ...commonSettingsShape,
  })
  .refine((s) => s.resourceName !== undefined || s.endpoint !== undefined, {
    message: 'resourceName or endpoint is required',
    path: ['resourceName'],
  });

export const foundryCredentialsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

export type FoundrySettings = z.infer<typeof foundrySettingsSchema>;
export type FoundryCredentials = z.infer<typeof foundryCredentialsSchema>;

export interface ResolvedDeployment {
  family: 'openai' | 'anthropic' | 'other';
  /** Name used for capability heuristics. */
  model: string;
  api: 'RESPONSES' | 'CHAT_COMPLETIONS';
  explicitCacheBreakpoints: boolean;
}

export function resolveDeployment(deployment: string, settings: FoundrySettings): ResolvedDeployment {
  const d = settings.deployments[deployment];
  const model = d?.model ?? deployment;
  const family = d?.modelFamily ?? settings.defaultModelFamily;
  return {
    family,
    model,
    api: family === 'openai' ? (d?.api ?? 'RESPONSES') : 'CHAT_COMPLETIONS',
    explicitCacheBreakpoints: d?.explicitCacheBreakpoints ?? usesOpenAiCacheBreakpoints(model),
  };
}

export function foundryCapabilities(deployment: string, settings: FoundrySettings): ModelCapabilities {
  const d = resolveDeployment(deployment, settings);
  const base =
    d.family === 'openai'
      ? openAiCapabilities(d.model, d.explicitCacheBreakpoints)
      : d.family === 'anthropic'
        ? claudeCapabilities(d.model)
        : genericChatCapabilities();
  return withOverrides(base, deployment, settings.capabilityOverrides);
}

/** Base URLs for the OpenAI v1 and Anthropic surfaces of a Foundry resource. */
export function foundryBaseUrls(settings: FoundrySettings): { openai: string; anthropic: string } {
  const root = (settings.endpoint ?? `https://${settings.resourceName}.services.ai.azure.com`).replace(/\/+$/, '');
  // Claude on Foundry lives at the resource level, even when a project endpoint is configured.
  return { openai: `${root}/openai/v1`, anthropic: `${new URL(root).origin}/anthropic/v1` };
}
