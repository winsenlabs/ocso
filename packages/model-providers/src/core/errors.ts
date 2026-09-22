import { DomainError, ErrorCategory, isDomainError } from '@ocso/domain';
import { APICallError, RetryError } from 'ai';
import type { ProviderKind } from '../contract/types.js';
import { classifyByName, classifyNetworkCode, classifyStatus, type Classification } from './error-classification.js';

/**
 * Converts any SDK/provider/network failure into a DomainError with a SAFE
 * message. Raw provider bodies, URLs, request bodies and credentials never
 * leave this module: messages come from fixed tables and `details` carries
 * only whitelisted scalar fields. The original error is NOT attached as
 * `cause`, because loggers serialize causes.
 */

export interface ErrorContext {
  kind: ProviderKind;
  providerId: string;
  model: string;
  /** True when the caller's own AbortSignal fired (cancellation, not timeout). */
  callerAborted: boolean;
  requestIdHeaders: readonly string[];
  secrets: readonly string[];
}

const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MIN_SECRET_LENGTH = 6;

interface ErrorFacts {
  name: string;
  statusCode: number | undefined;
  headers: Record<string, string> | undefined;
  bodyHint: string;
  providerCode: string | undefined;
  networkCode: string | undefined;
  isFetchFailure: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

function unwrap(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (RetryError.isInstance(current)) {
      current = current.lastError;
      continue;
    }
    const rec = asRecord(current);
    const cause = rec?.['cause'];
    if (!APICallError.isInstance(current) && cause !== undefined && (APICallError.isInstance(cause) || asRecord(cause)?.['statusCode'] !== undefined)) {
      current = cause;
      continue;
    }
    break;
  }
  return current;
}

/** First provider-defined identifier (e.g. `overloaded_error`, `ThrottlingException`). */
function providerCodeOf(rec: Record<string, unknown>, headers: Record<string, string> | undefined): string | undefined {
  const data = asRecord(rec['data']);
  const nestedError = asRecord(data?.['error']);
  const candidates: unknown[] = [
    headers?.['x-amzn-errortype']?.split(':')[0],
    nestedError?.['code'],
    nestedError?.['type'],
    nestedError?.['status'],
    data?.['type'],
    data?.['code'],
    data?.['__type'],
    rec['type'],
    rec['code'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && SAFE_CODE.test(c)) return c;
  }
  return undefined;
}

function factsOf(error: unknown): ErrorFacts {
  const rec = asRecord(error) ?? {};
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const headers = asRecord(rec['responseHeaders']) as Record<string, string> | undefined;
  const statusCode = typeof rec['statusCode'] === 'number' ? rec['statusCode'] : undefined;
  const body = typeof rec['responseBody'] === 'string' ? rec['responseBody'] : '';
  const data = rec['data'] === undefined ? '' : safeStringify(rec['data']);
  const message = typeof rec['message'] === 'string' ? rec['message'] : '';
  const providerCode = providerCodeOf(rec, headers);
  const cause = asRecord(rec['cause']);
  const networkCode = typeof cause?.['code'] === 'string' ? cause['code'] : typeof rec['code'] === 'string' ? rec['code'] : undefined;
  return {
    name,
    statusCode,
    headers,
    bodyHint: `${body} ${data} ${message} ${providerCode ?? ''}`.toLowerCase(),
    providerCode,
    networkCode,
    isFetchFailure: error instanceof TypeError && /fetch failed|network/i.test(message),
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

function isAbort(error: unknown): boolean {
  const name = asRecord(error)?.['name'];
  return name === 'AbortError' || name === 'TimeoutError';
}

function requestIdFrom(headers: Record<string, string> | undefined, names: readonly string[]): string | undefined {
  if (!headers) return undefined;
  for (const n of names) {
    const v = headers[n];
    if (typeof v === 'string' && SAFE_CODE.test(v.replace(/[^A-Za-z0-9_.:-]/g, '')) && v.length <= 128) return v;
  }
  return undefined;
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const ms = Number(headers?.['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const s = Number(headers?.['retry-after']);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= MIN_SECRET_LENGTH) out = out.split(s).join('[redacted]');
  }
  return out;
}

function classify(error: unknown, facts: ErrorFacts, ctx: ErrorContext): Classification {
  if (isAbort(error)) {
    return ctx.callerAborted
      ? { category: ErrorCategory.TIMEOUT, code: 'model_request_cancelled', message: 'The model request was cancelled' }
      : { category: ErrorCategory.TIMEOUT, code: 'model_timeout', message: 'The model request timed out' };
  }
  if (facts.statusCode !== undefined) return classifyStatus(facts.statusCode, facts.bodyHint);
  return (
    classifyByName(facts.name) ??
    classifyNetworkCode(facts.networkCode, facts.isFetchFailure) ?? {
      category: ErrorCategory.INTERNAL,
      code: 'model_call_failed',
      message: 'The model call failed unexpectedly',
    }
  );
}

export function normalizeProviderError(error: unknown, ctx: ErrorContext): DomainError {
  if (isDomainError(error)) return error;
  const root = unwrap(error);
  if (isDomainError(root)) return root;
  const facts = factsOf(root);
  const c = classify(root, facts, ctx);
  const details: Record<string, unknown> = {
    providerKind: ctx.kind,
    providerId: ctx.providerId,
    model: ctx.model,
  };
  if (facts.statusCode !== undefined) details['statusCode'] = facts.statusCode;
  if (facts.providerCode) details['providerErrorCode'] = scrubSecrets(facts.providerCode, ctx.secrets);
  const requestId = requestIdFrom(facts.headers, ctx.requestIdHeaders);
  if (requestId) details['providerRequestId'] = requestId;
  const retryAfter = retryAfterMs(facts.headers);
  if (retryAfter !== undefined) details['retryAfterMs'] = retryAfter;
  const status = facts.statusCode === undefined ? '' : ` (HTTP ${facts.statusCode})`;
  const message = scrubSecrets(`${c.message}${status} [${ctx.kind}]`, ctx.secrets);
  return new DomainError(c.category, c.code, message, details);
}
