import type { NormalizedUsage } from '../contract/types.js';

/**
 * Minimal structural view of AI SDK v7 usage (`LanguageModelUsage`). Declared
 * locally so SDK types never cross the adapter boundary (build rule §12).
 */
export interface SdkUsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    noCacheTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  outputTokenDetails?: { reasoningTokens?: number | undefined };
}

export interface UsageReportingProfile {
  /** Provider reports cache reads at all (false → null, not 0). */
  reportsCacheReads: boolean;
  /** Provider reports cache writes (Gemini does not). */
  reportsCacheWrites: boolean;
}

/**
 * The AI SDK already normalizes every provider into inputTokenDetails
 * (research/01 §4d). `inputTokens` includes cached reads and writes.
 */
export function normalizeUsage(u: SdkUsageLike | undefined, profile: UsageReportingProfile): NormalizedUsage {
  const input = u?.inputTokens ?? 0;
  const read = u?.inputTokenDetails?.cacheReadTokens;
  const write = u?.inputTokenDetails?.cacheWriteTokens;
  const cachedInputTokens = read ?? (profile.reportsCacheReads ? 0 : null);
  const cacheWriteTokens = write ?? (profile.reportsCacheWrites ? 0 : null);
  const uncached =
    u?.inputTokenDetails?.noCacheTokens ?? Math.max(0, input - (cachedInputTokens ?? 0) - (cacheWriteTokens ?? 0));
  return {
    inputTokens: input,
    uncachedInputTokens: uncached,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: u?.outputTokens ?? 0,
    reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? null,
  };
}

export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  const addNullable = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: addNullable(a.cachedInputTokens, b.cachedInputTokens),
    cacheWriteTokens: addNullable(a.cacheWriteTokens, b.cacheWriteTokens),
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: addNullable(a.reasoningTokens, b.reasoningTokens),
  };
}

export const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  outputTokens: 0,
  reasoningTokens: null,
};

/** Share of input tokens served from cache, or null when the provider does not report reads. */
export function cacheHitRatio(u: NormalizedUsage): number | null {
  if (u.cachedInputTokens === null || u.inputTokens === 0) return null;
  return u.cachedInputTokens / u.inputTokens;
}
