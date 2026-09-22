import type { ModelCapabilities } from '../../contract/types.js';
import { MAX_EXPLICIT_BREAKPOINTS } from './cache-plans.js';

/**
 * Prompt caching of one model in words, for the admin UI (ADR-006): the mode
 * (shown as a chip), the mechanism the adapter uses, and what a profile's
 * PREFIX cache policy sends for each requested TTL. Each provider words its
 * own mechanism, so the web app carries no per-provider caching copy.
 */
export type PromptCachingMode = 'explicit' | 'key-based' | 'implicit' | 'unverified' | 'none';

export interface PromptCachingDescription {
  mode: PromptCachingMode;
  /** e.g. "explicit cachePoint breakpoints (≤ 4)". */
  mechanism: string;
  /** What a PREFIX cache policy becomes for this model; `5m` also applies when the profile sets no TTL. */
  effect: { '5m': string; '1h': string };
}

/** Provider wording for `describePromptCaching`; anything omitted uses the generic text. */
export interface CachingWording {
  /** Mechanism when the model takes explicit breakpoints. */
  explicit?: string | undefined;
  /** What a 1h TTL becomes with explicit breakpoints (default "breakpoints · 1h TTL"). */
  explicitLongTtl?: string | undefined;
  /** Mechanism when caching is automatic (implicit prefix matching). */
  automatic?: string | undefined;
  /** Mechanism when caching is unverified. */
  unverified?: string | undefined;
}

const NOTHING_SENT = { '5m': 'nothing sent', '1h': 'nothing sent' };

/** From the model's declared capabilities (so settings.capabilityOverrides are honoured). */
export function describePromptCaching(caps: ModelCapabilities, wording: CachingWording = {}): PromptCachingDescription {
  switch (caps.promptCaching) {
    case 'EXPLICIT':
      return {
        mode: 'explicit',
        mechanism: wording.explicit ?? `explicit breakpoints (≤ ${MAX_EXPLICIT_BREAKPOINTS})`,
        effect: { '5m': 'breakpoints · 5m TTL', '1h': wording.explicitLongTtl ?? 'breakpoints · 1h TTL' },
      };
    case 'AUTOMATIC': {
      const managed = 'stable prefix · TTL managed by the provider';
      return { mode: 'implicit', mechanism: wording.automatic ?? 'automatic prefix caching', effect: { '5m': managed, '1h': managed } };
    }
    case 'UNVERIFIED':
      return { mode: 'unverified', mechanism: wording.unverified ?? 'unverified · no cache directives sent', effect: NOTHING_SENT };
    default:
      return { mode: 'none', mechanism: 'not supported for this model', effect: NOTHING_SENT };
  }
}

/** Anthropic Messages wording (Anthropic API, Claude on Vertex and on Foundry). */
export const CACHE_CONTROL_WORDING: CachingWording = { explicit: `explicit cache_control breakpoints (≤ ${MAX_EXPLICIT_BREAKPOINTS})` };

/**
 * OpenAI family (OpenAI API, OpenAI deployments on Foundry): automatic
 * caching steered by `promptCacheKey`; 24h retention before GPT-5.6, explicit
 * breakpoints and 30m implicit retention from 5.6 (see `openAiFamilyPlan`).
 */
export function keyBasedCaching(caps: ModelCapabilities, explicitBreakpoints: boolean): PromptCachingDescription {
  if (caps.promptCaching !== 'AUTOMATIC') return describePromptCaching(caps);
  return {
    mode: 'key-based',
    mechanism: explicitBreakpoints ? 'automatic + prompt cache key · explicit breakpoints (GPT-5.6+)' : 'automatic + prompt cache key',
    effect: { '5m': 'cache key · default retention', '1h': explicitBreakpoints ? 'cache key · 30m implicit retention' : 'cache key · 24h retention' },
  };
}
