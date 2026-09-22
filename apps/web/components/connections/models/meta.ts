import type { StatusTone } from '../../ui/status-chip';
import type { Capabilities, CapabilityKey, Provider, ProviderKind } from '../../../lib/api/models';

/**
 * Presentation of model providers and profiles (design/04). Pure and
 * client-safe; the caching copy restates ADR-006's per-provider table.
 */

/** Short mono logo text per kind (never a vendor logo). */
export const KIND_LOGO: Readonly<Record<ProviderKind, string>> = {
  BEDROCK: 'AWS',
  VERTEX: 'GCP',
  FOUNDRY: 'MSF',
  OPENAI: 'OAI',
  ANTHROPIC: 'ANT',
  SARVAM: 'SVM',
  DEV_SCRIPTED: 'DEV',
};

/** What each adapter does for prompt caching (ADR-006), shown on provider cards. */
export const KIND_CACHING: Readonly<Record<ProviderKind, string>> = {
  BEDROCK: 'cachePoint breakpoints (Claude, Nova)',
  VERTEX: 'implicit prefix (Gemini) · cache_control (Claude)',
  FOUNDRY: 'prompt cache key (OpenAI) · cache_control (Claude)',
  OPENAI: 'automatic · prompt cache key',
  ANTHROPIC: 'explicit cache_control breakpoints',
  SARVAM: 'no documented control · unverified',
  DEV_SCRIPTED: 'simulated explicit breakpoints',
};

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

export type CachingMode = 'explicit' | 'key-based' | 'implicit' | 'unverified' | 'none' | 'unknown';

const ANTHROPIC_FAMILY: ReadonlySet<ProviderKind> = new Set(['ANTHROPIC', 'VERTEX', 'FOUNDRY']);
const KEY_BASED: ReadonlySet<ProviderKind> = new Set(['OPENAI', 'FOUNDRY']);

/** How one target caches (ADR-006): explicit breakpoints, implicit/automatic, or key-based routing. */
export function cachingMode(kind: ProviderKind | null, caps: Capabilities | null): CachingMode {
  if (!kind || !caps) return 'unknown';
  switch (caps.promptCaching) {
    case 'EXPLICIT':
      return 'explicit';
    case 'AUTOMATIC':
      return KEY_BASED.has(kind) ? 'key-based' : 'implicit';
    case 'UNVERIFIED':
      return 'unverified';
    default:
      return 'none';
  }
}

/** The mechanism the adapter uses for this target. */
export function cachingMechanism(kind: ProviderKind | null, caps: Capabilities | null): string {
  const mode = cachingMode(kind, caps);
  if (mode === 'unknown') return 'unknown — provider kind unavailable or its settings are invalid';
  if (mode === 'none') return 'not supported for this model';
  if (mode === 'unverified') return kind === 'SARVAM' ? 'no documented control · cached tokens recorded if reported' : 'unverified · no cache directives sent';
  if (mode === 'explicit') {
    if (kind === 'BEDROCK') return 'explicit cachePoint breakpoints (≤ 4)';
    if (kind === 'DEV_SCRIPTED') return 'simulated explicit breakpoints (≤ 4)';
    return ANTHROPIC_FAMILY.has(kind!) ? 'explicit cache_control breakpoints (≤ 4)' : 'explicit breakpoints (≤ 4)';
  }
  if (mode === 'key-based') {
    return caps!.reportsCacheWrites ? 'automatic + prompt cache key · explicit breakpoints (GPT-5.6+)' : 'automatic + prompt cache key';
  }
  return kind === 'VERTEX' ? 'implicit prefix caching (stable prefix first)' : 'automatic prefix caching';
}

/** What this profile's cache policy and TTL turn into for one target. */
export function cacheSettingEffect(
  kind: ProviderKind | null,
  caps: Capabilities | null,
  policy: 'OFF' | 'PREFIX',
  ttl: '5m' | '1h' | null,
): string {
  if (policy === 'OFF') return 'off · no cache directives sent';
  const mode = cachingMode(kind, caps);
  if (mode === 'unknown' || mode === 'none' || mode === 'unverified') return 'nothing sent';
  if (mode === 'explicit') {
    if (ttl !== '1h') return 'breakpoints · 5m TTL';
    return kind === 'BEDROCK' ? 'breakpoints · 1h TTL on Claude 4.5+, else 5m' : 'breakpoints · 1h TTL';
  }
  if (mode === 'key-based') {
    if (ttl !== '1h') return 'cache key · default retention';
    return caps!.reportsCacheWrites ? 'cache key · 30m implicit retention' : 'cache key · 24h retention';
  }
  return 'stable prefix · TTL managed by the provider';
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
