import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * Model providers, logical model profiles and pricing (docs/06, ADR-006).
 * Shapes mirror packages/application/src/models/views.ts. Provider responses
 * carry credential NAMES and secret references only, never values.
 */

export const PROVIDER_KINDS = ['BEDROCK', 'VERTEX', 'FOUNDRY', 'OPENAI', 'ANTHROPIC', 'SARVAM', 'DEV_SCRIPTED'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const Kind = z.enum(PROVIDER_KINDS);

export const FieldDescriptorSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['string', 'url', 'integer', 'number', 'boolean', 'enum', 'json']),
  required: z.boolean(),
  secret: z.boolean(),
  description: z.string().optional(),
  options: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type FieldDescriptor = z.infer<typeof FieldDescriptorSchema>;

export const ProviderKindSchema = z.object({
  kind: Kind,
  label: z.string(),
  devOnly: z.boolean(),
  settings: z.array(FieldDescriptorSchema),
  credentials: z.array(FieldDescriptorSchema),
});
export type ProviderKindView = z.infer<typeof ProviderKindSchema>;

export const CapabilitiesSchema = z.object({
  imageInput: z.boolean(),
  fileInput: z.boolean(),
  audioInput: z.boolean(),
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  reasoning: z.boolean(),
  streaming: z.boolean(),
  promptCaching: z.enum(['EXPLICIT', 'AUTOMATIC', 'UNSUPPORTED', 'UNVERIFIED']),
  reportsCacheWrites: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const StatsSchema = z.object({
  requests: z.number(),
  errors: z.number(),
  errorRate: z.number().nullable(),
  p95LatencyMs: z.number().nullable(),
  p95TtftMs: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadRatio: z.number().nullable(),
  costMicros: z.number().nullable(),
  currency: z.string().nullable(),
});
export type UsageStats = z.infer<typeof StatsSchema>;

export const ProviderSchema = z.object({
  id: z.string(),
  kind: Kind,
  kindLabel: z.string(),
  devOnly: z.boolean(),
  available: z.boolean(),
  name: z.string(),
  region: z.string().nullable(),
  residencyZone: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  secretRefs: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  maxConcurrency: z.number(),
  status: z.enum(['UNTESTED', 'OK', 'DEGRADED', 'DOWN']),
  lastHealthAt: z.string().nullable(),
  lastHealthLatencyMs: z.number().nullable(),
  lastError: z.string().nullable(),
  policy: z.object({ allowlisted: z.boolean(), residency: z.enum(['NOT_REQUIRED', 'COMPLIANT', 'VIOLATION']) }),
  profiles: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['PRIMARY', 'FALLBACK']) })),
  stats24h: StatsSchema,
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderTestSchema = z.object({
  providerId: z.string(),
  status: z.enum(['OK', 'DEGRADED', 'DOWN', 'UNCONFIGURED']),
  model: z.string().nullable(),
  health: z.object({ status: z.string(), latencyMs: z.number().nullable(), checkedAt: z.string(), detail: z.string().optional() }),
  call: z
    .object({
      ok: z.boolean(),
      model: z.string(),
      latencyMs: z.number().nullable(),
      ttftMs: z.number().nullable(),
      replyPreview: z.string().nullable(),
      error: z.object({ category: z.string(), code: z.string(), message: z.string() }).nullable(),
    })
    .nullable(),
  checkedAt: z.string(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestSchema>;

const TargetSchema = z.object({
  role: z.enum(['PRIMARY', 'FALLBACK']),
  providerId: z.string(),
  providerName: z.string().nullable(),
  providerKind: Kind.nullable(),
  model: z.string(),
  capabilities: CapabilitiesSchema.nullable(),
});
export type ProfileTarget = z.infer<typeof TargetSchema>;

export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  providerId: z.string(),
  providerName: z.string().nullable(),
  providerKind: Kind.nullable(),
  region: z.string().nullable(),
  model: z.string(),
  temperature: z.number().nullable(),
  maxOutputTokens: z.number(),
  reasoning: z.enum(['none', 'low', 'medium', 'high']).nullable(),
  timeoutMs: z.number(),
  retries: z.number(),
  retryBackoffMs: z.number(),
  cachePolicy: z.enum(['OFF', 'PREFIX']),
  cacheTtl: z.enum(['5m', '1h']).nullable(),
  fallbacks: z.array(z.object({ providerId: z.string(), providerName: z.string().nullable(), providerKind: Kind.nullable(), model: z.string() })),
  requiredCapabilities: z.record(z.string(), z.boolean()),
  /** Absent on API builds before per-target capabilities were added. */
  targets: z.array(TargetSchema).default([]),
  configVersion: z.number(),
  agents: z.array(z.object({ id: z.string(), name: z.string(), usage: z.enum(['MODEL', 'SUMMARIZER', 'COPILOT']) })),
  stats24h: StatsSchema.nullable(),
  updatedAt: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const TargetCheckSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  providerKind: Kind,
  model: z.string(),
  region: z.string().nullable(),
  residencyZone: z.string().nullable(),
  permitted: z.boolean(),
  reason: z.string().nullable(),
  capabilities: CapabilitiesSchema.nullable(),
});
export type TargetCheck = z.infer<typeof TargetCheckSchema>;

export const PolicyCheckSchema = z.object({
  ok: z.boolean(),
  primary: TargetCheckSchema,
  fallbacks: z.array(TargetCheckSchema),
  warnings: z.array(z.string()),
  message: z.string(),
  policy: z.object({
    residencyZone: z.string().nullable(),
    providerAllowlist: z.array(z.string()),
    allowCrossProviderFallback: z.boolean(),
    allowCrossRegionFallback: z.boolean(),
  }),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

const ProfileSaveSchema = ProfileSchema.extend({ policy: PolicyCheckSchema });
export type ProfileSaveResult = z.infer<typeof ProfileSaveSchema>;

export const PricingSchema = z.object({
  id: z.string(),
  providerKind: Kind,
  modelPattern: z.string(),
  currency: z.string(),
  inputPerMTokMicros: z.number(),
  cachedInputPerMTokMicros: z.number().nullable(),
  cacheWritePerMTokMicros: z.number().nullable(),
  outputPerMTokMicros: z.number(),
  effectiveFrom: z.string(),
});
export type Pricing = z.infer<typeof PricingSchema>;

/** Request bodies (validated again by the API). */
export interface ProviderCreate {
  kind: ProviderKind;
  name: string;
  region: string | null;
  residencyZone: string | null;
  settings: Record<string, unknown>;
  credentials: Record<string, string>;
  enabled: boolean;
  maxConcurrency: number;
}
export interface ProviderUpdate {
  name?: string;
  region?: string | null;
  residencyZone?: string | null;
  settings?: Record<string, unknown>;
  /** A value rotates a credential, null removes it; omitted keys are kept. */
  credentials?: Record<string, string | null>;
  enabled?: boolean;
  maxConcurrency?: number;
}
export interface ProfileInput {
  name: string;
  description: string | null;
  providerId: string;
  model: string;
  temperature: number | null;
  maxOutputTokens: number;
  reasoning: 'none' | 'low' | 'medium' | 'high' | null;
  timeoutMs: number;
  retries: number;
  retryBackoffMs: number;
  cachePolicy: 'OFF' | 'PREFIX';
  cacheTtl: '5m' | '1h' | null;
  fallbacks: Array<{ providerId: string; model: string }>;
  requiredCapabilities: Partial<Record<CapabilityKey, boolean>>;
}
export const CAPABILITY_KEYS = ['imageInput', 'fileInput', 'audioInput', 'toolCalling', 'structuredOutput', 'streaming'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface PricingInput {
  providerKind: ProviderKind;
  modelPattern: string;
  currency: string;
  inputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
  outputPerMTokMicros: number;
}

export const listProviders = () => api.get('/v1/model-providers', z.array(ProviderSchema));
export const listProviderKinds = () => api.get('/v1/model-providers/kinds', z.array(ProviderKindSchema));
export const createProvider = (input: ProviderCreate) => api.post('/v1/model-providers', input, ProviderSchema);
export const updateProvider = (id: string, patch: ProviderUpdate) => api.patch(`/v1/model-providers/${id}`, patch, ProviderSchema);
export const deleteProvider = (id: string) => api.command('DELETE', `/v1/model-providers/${id}`);
/** Probes a real endpoint: allow for the adapter's 15 s health and 20 s generation timeouts. */
export const testProvider = (id: string, model: string | null) =>
  api.post(`/v1/model-providers/${id}/test`, model ? { model } : {}, ProviderTestSchema, { timeoutMs: 45_000 });

export const listProfiles = () => api.get('/v1/model-profiles', z.array(ProfileSchema));
export const validateProfile = (input: ProfileInput) => api.post('/v1/model-profiles/validate', input, PolicyCheckSchema);
export const createProfile = (input: ProfileInput) => api.post('/v1/model-profiles', input, ProfileSaveSchema);
export const updateProfile = (id: string, input: Partial<ProfileInput>) => api.patch(`/v1/model-profiles/${id}`, input, ProfileSaveSchema);
export const deleteProfile = (id: string) => api.command('DELETE', `/v1/model-profiles/${id}`);

export const listPricing = () => api.get('/v1/model-pricing', z.array(PricingSchema));
export const createPricing = (input: PricingInput) => api.post('/v1/model-pricing', input, PricingSchema);
export const updatePricing = (id: string, input: Partial<PricingInput>) => api.patch(`/v1/model-pricing/${id}`, input, PricingSchema);
export const deletePricing = (id: string) => api.command('DELETE', `/v1/model-pricing/${id}`);
