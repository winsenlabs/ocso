import { DomainError, ErrorCategory } from '@ocso/domain';
import type { ProviderKind } from '../contract/types.js';
import { classifyStatus } from '../core/error-classification.js';
import { normalizeProviderError, scrubSecrets } from '../core/errors.js';

/**
 * HTTP for model listings (GET /models and friends). Same rules as model
 * calls: the adapter's injected `fetch`, a hard deadline, and failures
 * normalized to DomainErrors with fixed messages. Response bodies are
 * inspected for classification only and never surfaced; credential values
 * are scrubbed from every message.
 */

export const MODEL_LIST_TIMEOUT_MS = 15_000;
/** Pagination guard: a listing never takes more than this many pages. */
export const MAX_LIST_PAGES = 20;
/** Error code for "this endpoint has no model listing" (callers fall back to the catalog). */
export const LISTING_UNSUPPORTED = 'model_listing_unsupported';

export interface ListContext {
  kind: ProviderKind;
  providerId: string;
  fetch: typeof fetch;
  secrets: readonly string[];
  abortSignal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

const errorContext = (ctx: ListContext) => ({
  kind: ctx.kind,
  providerId: ctx.providerId,
  model: '(model list)',
  callerAborted: ctx.abortSignal?.aborted === true,
  requestIdHeaders: [] as const,
  secrets: ctx.secrets,
});

export function listingUnsupported(ctx: Pick<ListContext, 'kind' | 'providerId'>): DomainError {
  return new DomainError(ErrorCategory.NOT_FOUND, LISTING_UNSUPPORTED, `This provider endpoint has no model listing [${ctx.kind}]`, {
    providerKind: ctx.kind,
    providerId: ctx.providerId,
  });
}

function statusError(ctx: ListContext, status: number, body: string): DomainError {
  if (status === 404) return listingUnsupported(ctx);
  const c = classifyStatus(status, body.toLowerCase());
  return new DomainError(c.category, c.code, scrubSecrets(`${c.message} (HTTP ${status}) [${ctx.kind}]`, ctx.secrets), {
    providerKind: ctx.kind,
    providerId: ctx.providerId,
    statusCode: status,
  });
}

export function invalidListing(ctx: Pick<ListContext, 'kind' | 'providerId'>): DomainError {
  return new DomainError(ErrorCategory.PROVIDER_UNAVAILABLE, 'provider_invalid_response', `The model provider returned an invalid model list [${ctx.kind}]`, {
    providerKind: ctx.kind,
    providerId: ctx.providerId,
  });
}

/** GET a JSON document. `headers` may carry credentials; they are never echoed. */
export async function getJson(ctx: ListContext, url: string, headers: Record<string, string>): Promise<unknown> {
  const deadline = AbortSignal.timeout(ctx.timeoutMs ?? MODEL_LIST_TIMEOUT_MS);
  const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, deadline]) : deadline;
  let response: Response;
  try {
    response = await ctx.fetch(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal });
  } catch (error) {
    throw normalizeProviderError(error, errorContext(ctx));
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw statusError(ctx, response.status, body);
  }
  try {
    return await response.json();
  } catch {
    throw invalidListing(ctx);
  }
}

/** ISO string from an RFC 3339 string or unix seconds; null when absent or zero/epoch. */
export function isoOrNull(value: unknown): string | null {
  if (typeof value === 'number') return value > 0 ? new Date(value * 1000).toISOString() : null;
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
  }
  return null;
}

/** Trailing-slash-free base URL. */
export const trimBase = (url: string) => url.replace(/\/+$/, '');
