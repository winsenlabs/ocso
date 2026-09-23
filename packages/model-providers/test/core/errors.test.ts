import { DomainError, ErrorCategory } from '@ocso/domain';
import { APICallError, LoadAPIKeyError, InvalidPromptError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { normalizeProviderError, scrubSecrets, type ErrorContext } from '../../src/core/errors.js';

const SECRET = 'sk-live-TOPSECRET-123456';

const ctx = (over: Partial<ErrorContext> = {}): ErrorContext => ({
  kind: 'OPENAI',
  providerId: 'prov-1',
  model: 'gpt-5.5',
  callerAborted: false,
  requestIdHeaders: ['x-request-id'],
  secrets: [SECRET],
  ...over,
});

const apiError = (statusCode: number | undefined, body: unknown = { error: { message: `bad ${SECRET}` } }, headers: Record<string, string> = {}) =>
  new APICallError({
    message: `Upstream error ${SECRET}`,
    url: `https://api.example.com/v1?key=${SECRET}`,
    requestBodyValues: { apiKey: SECRET, messages: ['customer PII'] },
    ...(statusCode !== undefined ? { statusCode } : {}),
    responseHeaders: headers,
    responseBody: JSON.stringify(body),
    data: body,
    isRetryable: false,
  });

describe('normalizeProviderError', () => {
  it.each([
    [400, ErrorCategory.VALIDATION, 'provider_rejected_request'],
    [401, ErrorCategory.AUTHENTICATION, 'provider_authentication_failed'],
    [403, ErrorCategory.AUTHORIZATION, 'provider_access_denied'],
    [404, ErrorCategory.NOT_FOUND, 'provider_model_not_found'],
    [408, ErrorCategory.TIMEOUT, 'provider_timeout'],
    [413, ErrorCategory.VALIDATION, 'provider_request_too_large'],
    [429, ErrorCategory.PROVIDER_RATE_LIMITED, 'provider_rate_limited'],
    [500, ErrorCategory.PROVIDER_UNAVAILABLE, 'provider_unavailable'],
    [502, ErrorCategory.PROVIDER_UNAVAILABLE, 'provider_unavailable'],
    [504, ErrorCategory.TIMEOUT, 'provider_timeout'],
    [529, ErrorCategory.PROVIDER_UNAVAILABLE, 'provider_overloaded'],
  ])('maps HTTP %i to %s/%s', (status, category, code) => {
    const e = normalizeProviderError(apiError(status), ctx());
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toMatchObject({ category, code });
    expect(e.details).toMatchObject({ statusCode: status, providerKind: 'OPENAI', providerId: 'prov-1', model: 'gpt-5.5' });
  });

  it('never carries raw bodies, URLs, request bodies or secrets, and attaches no cause', () => {
    const e = normalizeProviderError(apiError(500), ctx());
    const all = `${e.message} ${JSON.stringify(e)} ${JSON.stringify(e.details)} ${e.stack}`;
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('customer PII');
    expect(all).not.toContain('api.example.com');
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it('classifies content-filter and context-length 400s', () => {
    const filtered = normalizeProviderError(apiError(400, { error: { code: 'content_filter', message: 'blocked' } }), ctx());
    expect(filtered).toMatchObject({ category: ErrorCategory.POLICY_DENIED, code: 'provider_content_filtered' });
    const tooLong = normalizeProviderError(apiError(400, { error: { code: 'context_length_exceeded' } }), ctx());
    expect(tooLong).toMatchObject({ category: ErrorCategory.VALIDATION, code: 'provider_context_length_exceeded' });
  });

  it('keeps only safe provider codes, request ids and retry hints', () => {
    const e = normalizeProviderError(
      apiError(429, { error: { type: 'rate_limit_error', message: SECRET } }, { 'x-request-id': 'req_123', 'retry-after': '7' }),
      ctx(),
    );
    expect(e.details).toMatchObject({ providerErrorCode: 'rate_limit_error', providerRequestId: 'req_123', retryAfterMs: 7000 });
    const unsafe = normalizeProviderError(apiError(429, { error: { code: 'has spaces and <html>' } }), ctx());
    expect(unsafe.details?.['providerErrorCode']).toBeUndefined();
  });

  it('unwraps RetryError to the last provider error', () => {
    const retry = new RetryError({ message: 'x', reason: 'maxRetriesExceeded', errors: [apiError(500), apiError(429)] });
    expect(normalizeProviderError(retry, ctx()).category).toBe(ErrorCategory.PROVIDER_RATE_LIMITED);
  });

  it('distinguishes timeouts from caller cancellation', () => {
    expect(normalizeProviderError(new DOMException('t', 'TimeoutError'), ctx())).toMatchObject({ category: 'timeout', code: 'model_timeout' });
    expect(normalizeProviderError(new DOMException('a', 'AbortError'), ctx({ callerAborted: true }))).toMatchObject({
      category: 'timeout',
      code: 'model_request_cancelled',
    });
  });

  it('maps network failures', () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(normalizeProviderError(reset, ctx())).toMatchObject({ category: 'provider_unavailable', code: 'provider_unreachable' });
    const slow = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    expect(normalizeProviderError(slow, ctx())).toMatchObject({ category: 'timeout' });
  });

  it('maps SDK configuration and prompt errors', () => {
    expect(normalizeProviderError(new LoadAPIKeyError({ message: `missing ${SECRET}` }), ctx())).toMatchObject({
      category: 'authentication',
      code: 'provider_credentials_missing',
    });
    expect(normalizeProviderError(new InvalidPromptError({ prompt: SECRET, message: 'bad' }), ctx())).toMatchObject({
      category: 'validation',
      code: 'model_request_invalid',
    });
  });

  it('maps the Bedrock provider\'s re-wrapped credential-chain failure to authentication', () => {
    const wrapped = new Error(`AWS credential provider failed: Could not load credentials from any providers ${SECRET}.`);
    const e = normalizeProviderError(wrapped, ctx({ kind: 'BEDROCK' }));
    expect(e).toMatchObject({ category: 'authentication', code: 'provider_credentials_unavailable' });
    expect(e.message).not.toContain(SECRET);
  });

  it('maps in-stream provider errors (statusCode on a plain error object)', () => {
    const streamError = { message: `overloaded ${SECRET}`, type: 'overloaded_error', statusCode: 529, isRetryable: true };
    expect(normalizeProviderError(streamError, ctx())).toMatchObject({ category: 'provider_unavailable', code: 'provider_overloaded' });
  });

  it('passes DomainErrors through and defaults unknown errors to internal', () => {
    const domain = new DomainError(ErrorCategory.AUTHENTICATION, 'x', 'y');
    expect(normalizeProviderError(domain, ctx())).toBe(domain);
    expect(normalizeProviderError(new Error(SECRET), ctx())).toMatchObject({ category: 'internal', code: 'model_call_failed' });
    expect(normalizeProviderError(new Error(SECRET), ctx()).message).not.toContain(SECRET);
  });
});

describe('scrubSecrets', () => {
  it('redacts every configured secret of useful length', () => {
    expect(scrubSecrets(`a ${SECRET} b ${SECRET}`, [SECRET, 'ab'])).toBe('a [redacted] b [redacted]');
  });
});
