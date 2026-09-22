import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';

/** A model provider kind (`OPENAI`, `BEDROCK`…). Open: the provider registry, not the schema, decides which kinds exist. */
export type ProviderKindColumn = string;

/** Provider = infrastructure (endpoint, region, credentials by reference). */
export const modelProviders = pgTable(
  'model_providers',
  {
    id: id(),
    kind: text().$type<ProviderKindColumn>().notNull(),
    name: text().notNull(),
    region: text(),
    residencyZone: text(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Credential name → secret reference. Never plaintext. */
    secretRefs: jsonb().$type<Record<string, string>>().notNull().default({}),
    enabled: boolean().notNull().default(true),
    maxConcurrency: integer().notNull().default(50),
    status: text().$type<'UNTESTED' | 'OK' | 'DEGRADED' | 'DOWN'>().notNull().default('UNTESTED'),
    lastHealthAt: ts('last_health_at'),
    lastHealthLatencyMs: integer(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('model_providers_name_uq').on(sql`lower(${t.name})`)],
);

export interface ProfileFallback {
  providerId: string;
  model: string;
}

/** Logical model profile — agents reference these, never provider model ids (docs/06 §2). */
export const modelProfiles = pgTable(
  'model_profiles',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    providerId: uuid()
      .notNull()
      .references(() => modelProviders.id),
    model: text().notNull(),
    temperature: real(),
    maxOutputTokens: integer().notNull().default(1024),
    reasoning: text().$type<'none' | 'low' | 'medium' | 'high'>(),
    timeoutMs: integer().notNull().default(30_000),
    retries: integer().notNull().default(1),
    retryBackoffMs: integer().notNull().default(400),
    cachePolicy: text().$type<'OFF' | 'PREFIX'>().notNull().default('PREFIX'),
    cacheTtl: text().$type<'5m' | '1h'>(),
    fallbacks: jsonb().$type<ProfileFallback[]>().notNull().default([]),
    requiredCapabilities: jsonb().$type<Record<string, boolean>>().notNull().default({}),
    /** Bumped on every change; part of turn-cache keys. */
    configVersion: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('model_profiles_name_uq').on(t.name)],
);

/** Long-context price tier of a pricing row (micro-units per 1M tokens). */
export interface PriceTierColumn {
  /** Applies when the request's input tokens exceed this many. */
  aboveInputTokens: number;
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  cachedInputPerMTokMicros: number | null;
  cacheWritePerMTokMicros: number | null;
}

/**
 * Price table for cost metadata (micro-units per 1M tokens), the costing
 * source of truth (ADR-027). `origin = 'catalog'` rows were pre-filled from
 * the open-source model catalog (source + fetch date) and follow catalog
 * refreshes; `manual` rows are the Tech Admin's and are never overwritten.
 */
export const modelPricing = pgTable('model_pricing', {
  id: id(),
  providerKind: text().$type<ProviderKindColumn>().notNull(),
  modelPattern: text().notNull(),
  currency: text().notNull().default('USD'),
  inputPerMTokMicros: bigint({ mode: 'number' }).notNull(),
  cachedInputPerMTokMicros: bigint({ mode: 'number' }),
  cacheWritePerMTokMicros: bigint({ mode: 'number' }),
  outputPerMTokMicros: bigint({ mode: 'number' }).notNull(),
  /** Long-context tiers (e.g. > 272K input tokens), highest applicable tier wins. */
  tiers: jsonb().$type<PriceTierColumn[]>(),
  origin: text().$type<'catalog' | 'manual'>().notNull().default('manual'),
  /** Catalog rows: `models.dev` | `litellm`, the catalog's provider and model keys, and when OCSO fetched that catalog. */
  catalogSource: text(),
  catalogProvider: text(),
  catalogModelId: text(),
  catalogFetchedAt: ts('catalog_fetched_at'),
  effectiveFrom: ts('effective_from').notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: ts('updated_at'),
});

/**
 * Latest normalized snapshot per open-source model catalog (ADR-027),
 * refreshed daily by the worker leader and on demand. `entries` is the
 * validated, normalized catalog (USD per 1M tokens).
 */
export const modelCatalogSnapshots = pgTable('model_catalog_snapshots', {
  source: text().$type<'models.dev' | 'litellm'>().primaryKey(),
  fetchedAt: ts('fetched_at').notNull(),
  contentHash: text().notNull(),
  entryCount: integer().notNull(),
  entries: jsonb().$type<unknown[]>().notNull(),
  /** Last attempt (success or failure) and its outcome, for the status panel. */
  lastAttemptAt: ts('last_attempt_at').notNull(),
  lastError: text(),
  updatedAt: updatedAt(),
});

/** One row per model request (docs/03 UsageEvent, docs/05 §3). */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: id(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    purpose: text().notNull(),
    conversationId: uuid(),
    turnId: uuid(),
    agentId: uuid(),
    userId: uuid(),
    profileId: uuid(),
    providerId: uuid(),
    providerKind: text().$type<ProviderKindColumn>(),
    model: text(),
    region: text(),
    inputTokens: integer().notNull().default(0),
    uncachedInputTokens: integer().notNull().default(0),
    cachedInputTokens: integer(),
    cacheWriteTokens: integer(),
    outputTokens: integer().notNull().default(0),
    reasoningTokens: integer(),
    latencyMs: integer(),
    ttftMs: integer(),
    status: text().$type<'OK' | 'ERROR'>().notNull(),
    errorCategory: text(),
    fallbackFromProviderId: uuid(),
    attempt: integer().notNull().default(1),
    providerRequestId: text(),
    costMicros: bigint({ mode: 'number' }),
    currency: text(),
    traceId: text(),
  },
  (t) => [
    index('usage_events_time_idx').on(t.occurredAt),
    index('usage_events_agent_idx').on(t.agentId, t.occurredAt),
    index('usage_events_provider_idx').on(t.providerId, t.occurredAt),
    index('usage_events_profile_idx').on(t.profileId, t.occurredAt),
    index('usage_events_turn_idx').on(t.turnId),
  ],
);
