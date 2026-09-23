import { DomainError, ErrorCategory, isDomainError } from '@ocso/domain';
import type { LanguageModelUsage } from 'ai';
import type { AdapterDeps } from '../../contract/types.js';
import type { SdkUsageLike } from '../../core/usage.js';

/** `{ fetch }` only when injected (exactOptionalPropertyTypes-friendly spread). */
export const fetchOption = (deps: AdapterDeps): { fetch?: typeof fetch } => (deps.fetch ? { fetch: deps.fetch } : {});

/**
 * Several SDK providers report `0` for cache (and reasoning) counters the
 * server never sent. Where the model's reporting is not guaranteed, keep a
 * counter only if the raw provider usage actually contained it, so that
 * "not reported" stays `null` after normalization.
 */
export function keepOnlyReportedCounters(
  usage: LanguageModelUsage,
  reported: { cacheRead: boolean; cacheWrite: boolean; reasoning: boolean },
): SdkUsageLike {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokenDetails.noCacheTokens,
      cacheReadTokens: reported.cacheRead ? usage.inputTokenDetails.cacheReadTokens : undefined,
      cacheWriteTokens: reported.cacheWrite ? usage.inputTokenDetails.cacheWriteTokens : undefined,
    },
    outputTokenDetails: { reasoningTokens: reported.reasoning ? usage.outputTokenDetails.reasoningTokens : undefined },
  };
}

const isNumber = (v: unknown) => typeof v === 'number';

/** OpenAI-compatible Chat Completions (`prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`). */
export function openAiCompatibleUsage(usage: LanguageModelUsage): SdkUsageLike {
  const raw = usage.raw as
    | { prompt_tokens_details?: { cached_tokens?: unknown }; completion_tokens_details?: { reasoning_tokens?: unknown } }
    | undefined;
  return keepOnlyReportedCounters(usage, {
    cacheRead: isNumber(raw?.prompt_tokens_details?.cached_tokens),
    cacheWrite: false,
    reasoning: isNumber(raw?.completion_tokens_details?.reasoning_tokens),
  });
}

/**
 * Wrap a credential/token acquisition step so SDK-specific failures surface
 * as a safe AUTHENTICATION DomainError (never the underlying message, which
 * can include tenant ids, key ids or file paths).
 */
export async function acquireCredential<T>(what: string, acquire: () => Promise<T>): Promise<T> {
  try {
    return await acquire();
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new DomainError(ErrorCategory.AUTHENTICATION, 'provider_credentials_unavailable', `${what} could not be obtained`);
  }
}
