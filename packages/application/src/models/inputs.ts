import { PROVIDER_KINDS } from '@ocso/model-providers';
import { z } from 'zod';

/**
 * HTTP/service input contracts for model administration (build rule §19).
 * Credential values appear only here, on the way into the SecretStore.
 */

const credentialValue = z.string().min(1).max(16_000);
const zone = z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, 'letters, digits and dashes only');

export const ProviderInput = z.object({
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(40).nullable().default(null),
  /** Where the provider keeps customer data, e.g. `IN`, `EU`, `GLOBAL` (docs/06 §5). */
  residencyZone: zone.nullable().default(null),
  /** Non-secret settings, validated against the provider definition's settingsSchema. */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Plaintext credentials entered once; stored in the SecretStore and never returned. */
  credentials: z.record(z.string(), credentialValue).default({}),
  enabled: z.boolean().default(true),
  maxConcurrency: z.number().int().min(1).max(10_000).default(50),
});
export type ProviderInput = z.infer<typeof ProviderInput>;

export const ProviderPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  region: z.string().trim().min(1).max(40).nullable().optional(),
  residencyZone: zone.nullable().optional(),
  /** Replaces the stored settings as a whole. */
  settings: z.record(z.string(), z.unknown()).optional(),
  /** Per credential: a value rotates (or adds) it, `null` removes it; omitted keys are kept. */
  credentials: z.record(z.string(), credentialValue.nullable()).optional(),
  enabled: z.boolean().optional(),
  maxConcurrency: z.number().int().min(1).max(10_000).optional(),
});
export type ProviderPatch = z.infer<typeof ProviderPatch>;

export const ProviderTestInput = z.object({
  /** Model/deployment to probe; defaults to settings.healthModel, then a profile's model. */
  model: z.string().trim().min(1).max(200).optional(),
});
export type ProviderTestInput = z.infer<typeof ProviderTestInput>;

/** Logical profile names are stable, lowercase slugs agents and dashboards refer to. */
export const PROFILE_NAME = /^[a-z][a-z0-9-]{1,48}$/;

const Fallback = z.object({ providerId: z.uuid(), model: z.string().trim().min(1).max(200) });

export const RequiredCapabilities = z
  .object({
    imageInput: z.boolean(),
    fileInput: z.boolean(),
    audioInput: z.boolean(),
    toolCalling: z.boolean(),
    structuredOutput: z.boolean(),
    streaming: z.boolean(),
  })
  .partial()
  .strict();

const profileFields = {
  name: z.string().regex(PROFILE_NAME, 'lowercase letters, digits and dashes; starts with a letter; 2-49 characters'),
  description: z.string().trim().max(500).nullable(),
  providerId: z.uuid(),
  model: z.string().trim().min(1).max(200),
  temperature: z.number().min(0).max(2).nullable(),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  reasoning: z.enum(['none', 'low', 'medium', 'high']).nullable(),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  retries: z.number().int().min(0).max(5),
  retryBackoffMs: z.number().int().min(0).max(60_000),
  cachePolicy: z.enum(['OFF', 'PREFIX']),
  cacheTtl: z.enum(['5m', '1h']).nullable(),
  fallbacks: z.array(Fallback).max(5),
  requiredCapabilities: RequiredCapabilities,
};

export const ProfileInput = z.object({
  ...profileFields,
  description: profileFields.description.default(null),
  temperature: profileFields.temperature.default(null),
  maxOutputTokens: profileFields.maxOutputTokens.default(1024),
  reasoning: profileFields.reasoning.default(null),
  timeoutMs: profileFields.timeoutMs.default(30_000),
  retries: profileFields.retries.default(1),
  retryBackoffMs: profileFields.retryBackoffMs.default(400),
  cachePolicy: profileFields.cachePolicy.default('PREFIX'),
  cacheTtl: profileFields.cacheTtl.default(null),
  fallbacks: profileFields.fallbacks.default([]),
  requiredCapabilities: RequiredCapabilities.default({}),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

export const ProfilePatch = z.object(profileFields).partial();
export type ProfilePatch = z.infer<typeof ProfilePatch>;

const micros = z.number().int().min(0).max(1_000_000_000_000);

export const PricingInput = z.object({
  providerKind: z.enum(PROVIDER_KINDS),
  /** Exact model id, or a prefix ending in `*` (e.g. `claude-sonnet-4-*`). */
  modelPattern: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  inputPerMTokMicros: micros,
  cachedInputPerMTokMicros: micros.nullable().default(null),
  cacheWritePerMTokMicros: micros.nullable().default(null),
  outputPerMTokMicros: micros,
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});
export type PricingInput = z.infer<typeof PricingInput>;

export const PricingPatch = z.object({
  modelPattern: z.string().trim().min(1).max(200).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  inputPerMTokMicros: micros.optional(),
  cachedInputPerMTokMicros: micros.nullable().optional(),
  cacheWritePerMTokMicros: micros.nullable().optional(),
  outputPerMTokMicros: micros.optional(),
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});
export type PricingPatch = z.infer<typeof PricingPatch>;

/** "Use the catalog price" for one model (POST /v1/model-pricing/from-catalog). */
export const CatalogPriceInput = z.object({
  providerKind: z.enum(PROVIDER_KINDS),
  model: z.string().trim().min(1).max(200),
  /** The configured provider, for Foundry deployments (their underlying model comes from its settings). */
  providerId: z.uuid().optional(),
});
export type CatalogPriceInput = z.infer<typeof CatalogPriceInput>;
