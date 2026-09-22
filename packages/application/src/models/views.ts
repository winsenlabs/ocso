import type { deploymentSettings, modelProfiles } from '@ocso/db';
import type { ProviderKind, ProviderRegistry } from '@ocso/model-providers';
import type { ProviderRow } from './provider-config.js';
import type { ProfileAgentRef, ProviderProfileRef } from './references.js';
import type { ModelUsageStats } from './usage-stats.js';

/**
 * Response shapes for model administration. Provider views carry credential
 * NAMES and secret REFERENCES only; values never leave the SecretStore.
 */

export type ProfileRow = typeof modelProfiles.$inferSelect;
type DeploymentPolicyRow = Pick<typeof deploymentSettings.$inferSelect, 'providerAllowlist' | 'residencyZone'>;

export interface ProviderPolicyView {
  /** On the deployment allowlist (an empty allowlist admits every provider). */
  allowlisted: boolean;
  residency: 'NOT_REQUIRED' | 'COMPLIANT' | 'VIOLATION';
}

export interface ProviderView {
  id: string;
  kind: ProviderKind;
  kindLabel: string;
  devOnly: boolean;
  /** False when this deployment does not register the kind (e.g. dev providers switched off). */
  available: boolean;
  name: string;
  region: string | null;
  residencyZone: string | null;
  settings: Record<string, unknown>;
  /** Credential name → secret reference. Never values. */
  secretRefs: Record<string, string>;
  enabled: boolean;
  maxConcurrency: number;
  status: ProviderRow['status'];
  lastHealthAt: string | null;
  lastHealthLatencyMs: number | null;
  lastError: string | null;
  policy: ProviderPolicyView;
  profiles: ProviderProfileRef[];
  stats24h: ModelUsageStats;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileFallbackView {
  providerId: string;
  providerName: string | null;
  providerKind: ProviderKind | null;
  model: string;
}

export interface ProfileView {
  id: string;
  name: string;
  description: string | null;
  providerId: string;
  providerName: string | null;
  providerKind: ProviderKind | null;
  /** Region of the primary provider. */
  region: string | null;
  model: string;
  temperature: number | null;
  maxOutputTokens: number;
  reasoning: ProfileRow['reasoning'];
  timeoutMs: number;
  retries: number;
  retryBackoffMs: number;
  cachePolicy: ProfileRow['cachePolicy'];
  cacheTtl: ProfileRow['cacheTtl'];
  fallbacks: ProfileFallbackView[];
  requiredCapabilities: Record<string, boolean>;
  configVersion: number;
  agents: ProfileAgentRef[];
  /** Technical telemetry; null for callers without provider read access (build rule §15). */
  stats24h: ModelUsageStats | null;
  createdAt: string;
  updatedAt: string;
}

export function providerPolicy(row: Pick<ProviderRow, 'id' | 'residencyZone'>, settings: DeploymentPolicyRow | undefined): ProviderPolicyView {
  const allowlist = settings?.providerAllowlist ?? [];
  const zone = settings?.residencyZone ?? null;
  return {
    allowlisted: allowlist.length === 0 || allowlist.includes(row.id),
    residency: zone === null ? 'NOT_REQUIRED' : row.residencyZone === zone ? 'COMPLIANT' : 'VIOLATION',
  };
}

export function toProviderView(
  row: ProviderRow,
  extra: { registry: ProviderRegistry; settings: DeploymentPolicyRow | undefined; profiles: ProviderProfileRef[]; stats: ModelUsageStats },
): ProviderView {
  const definition = extra.registry.get(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: definition?.label ?? row.kind,
    devOnly: definition?.devOnly ?? row.kind === 'DEV_SCRIPTED',
    available: definition !== undefined,
    name: row.name,
    region: row.region,
    residencyZone: row.residencyZone,
    settings: row.settings,
    secretRefs: { ...row.secretRefs },
    enabled: row.enabled,
    maxConcurrency: row.maxConcurrency,
    status: row.status,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
    lastHealthLatencyMs: row.lastHealthLatencyMs,
    lastError: row.lastError,
    policy: providerPolicy(row, extra.settings),
    profiles: extra.profiles,
    stats24h: extra.stats,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProfileView(
  row: ProfileRow,
  extra: { providers: ReadonlyMap<string, ProviderRow>; agents: ProfileAgentRef[]; stats: ModelUsageStats | null },
): ProfileView {
  const primary = extra.providers.get(row.providerId);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    providerId: row.providerId,
    providerName: primary?.name ?? null,
    providerKind: primary?.kind ?? null,
    region: primary?.region ?? null,
    model: row.model,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    reasoning: row.reasoning,
    timeoutMs: row.timeoutMs,
    retries: row.retries,
    retryBackoffMs: row.retryBackoffMs,
    cachePolicy: row.cachePolicy,
    cacheTtl: row.cacheTtl,
    fallbacks: row.fallbacks.map((f) => {
      const p = extra.providers.get(f.providerId);
      return { providerId: f.providerId, providerName: p?.name ?? null, providerKind: p?.kind ?? null, model: f.model };
    }),
    requiredCapabilities: row.requiredCapabilities,
    configVersion: row.configVersion,
    agents: extra.agents,
    stats24h: extra.stats,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
