import type { StatusTone } from '../../ui/status-chip';
import type { CapabilityKey, PromptCaching, Provider, ProviderKindView } from '../../../lib/api/models';

/**
 * Presentation of model providers and profiles (design/04). Pure and
 * client-safe. Nothing here names a provider kind: marks, labels and caching
 * wording come from the provider definitions through the API
 * (GET /v1/model-providers/kinds, and each target's `caching`).
 */

/**
 * Short mono mark for a kind (never a vendor logo): the definition's own, else
 * derived from the kind, so a kind this build has never seen still renders.
 */
export function providerMark(kind: string, view?: Pick<ProviderKindView, 'mark'> | undefined): string {
  if (view?.mark) return view.mark;
  const letters = kind.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return letters.slice(0, 3) || '?';
}

/** The kind's one-line caching summary for provider cards; unknown kinds say so. */
export const cachingSummary = (view: Pick<ProviderKindView, 'cachingSummary'> | undefined): string => view?.cachingSummary ?? 'not described by this deployment';

export const CAPABILITY_LABELS: Readonly<Record<CapabilityKey, string>> = {
  imageInput: 'Image input',
  fileInput: 'File input',
  audioInput: 'Audio input',
  toolCalling: 'Tool calling',
  structuredOutput: 'Structured output',
  streaming: 'Streaming',
};

export function providerStatus(p: Pick<Provider, 'enabled' | 'available' | 'status'>): { tone: StatusTone; label: string } {
  if (!p.available) return { tone: 'danger', label: 'not available' };
  if (!p.enabled) return { tone: 'muted', label: 'disabled' };
  switch (p.status) {
    case 'OK':
      return { tone: 'good', label: 'connected' };
    case 'DEGRADED':
      return { tone: 'warn', label: 'degraded' };
    case 'DOWN':
      return { tone: 'danger', label: 'down' };
    default:
      return { tone: 'muted', label: 'untested' };
  }
}

/** Card border: amber for degraded or erroring providers, red when down. */
export function providerTone(p: Pick<Provider, 'enabled' | 'available' | 'status' | 'stats24h'>): 'warn' | 'danger' | undefined {
  if (!p.available || (p.enabled && p.status === 'DOWN')) return 'danger';
  if (p.enabled && (p.status === 'DEGRADED' || p.stats24h.errors > 0)) return 'warn';
  return undefined;
}

/** explicit · key-based · implicit · unverified · none (as the provider describes it), or unknown when nothing describes it. */
export type CachingMode = string;

/**
 * How one target caches (ADR-006), from the provider's own description; null
 * when its kind is unavailable here or its stored settings are invalid.
 */
export const cachingMode = (caching: PromptCaching | null): CachingMode => caching?.mode ?? 'unknown';

/** The mechanism the adapter uses for this target. */
export const cachingMechanism = (caching: PromptCaching | null): string =>
  caching?.mechanism ?? 'unknown — provider kind unavailable or its settings are invalid';

/** What this profile's cache policy and TTL turn into for one target (no TTL = the 5m default). */
export function cacheSettingEffect(caching: PromptCaching | null, policy: 'OFF' | 'PREFIX', ttl: '5m' | '1h' | null): string {
  if (policy === 'OFF') return 'off · no cache directives sent';
  if (!caching) return 'nothing sent';
  return caching.effect[ttl === '1h' ? '1h' : '5m'];
}

/** Human text for a target rejection reason from POST /v1/model-profiles/validate. */
export function targetReasonText(reason: string | null): string {
  if (!reason) return 'permitted';
  if (reason.startsWith('missing_capability:')) return `lacks ${reason.slice('missing_capability:'.length)}`;
  const known: Record<string, string> = {
    provider_not_allowlisted: 'not on the provider allowlist',
    residency_violation: 'outside the required residency zone',
    cross_provider_forbidden: 'cross-provider fallback is off',
    cross_region_forbidden: 'cross-region fallback is off',
    cost_ceiling_exceeded: 'above the cost ceiling',
    provider_disabled: 'provider disabled',
    provider_kind_not_available: 'provider kind not available',
    provider_configuration_invalid: 'stored configuration invalid',
  };
  return known[reason] ?? reason.replace(/_/g, ' ');
}
