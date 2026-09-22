import { ErrorCategory } from '@ocso/domain';

/**
 * Pure classification tables for provider failures. Kept separate from the
 * normalizer so the mapping is reviewable at a glance.
 */

export interface Classification {
  category: ErrorCategory;
  code: string;
  message: string;
}

const CONTENT_FILTER_MARKERS = [
  'content_filter',
  'content_policy',
  'contentfilter',
  'responsibleaipolicyviolation',
  'guardrail',
  'usage policy',
];

const CONTEXT_LENGTH_MARKERS = [
  'context_length_exceeded',
  'context length',
  'context window',
  'prompt is too long',
  'input is too long',
  'too many tokens',
  'maximum context',
  'max_tokens_exceeded',
];

const QUOTA_MARKERS = ['insufficient_quota', 'quota exceeded', 'quota_exceeded', 'servicequotaexceeded'];

const includesAny = (haystack: string, needles: readonly string[]) => needles.some((n) => haystack.includes(n));

/**
 * Map an HTTP(-equivalent) status to a category. `bodyHint` is the lowercased
 * raw provider body/code, inspected here but never surfaced.
 */
export function classifyStatus(status: number, bodyHint: string): Classification {
  if (status === 400 || status === 422) {
    if (includesAny(bodyHint, CONTENT_FILTER_MARKERS)) {
      return {
        category: ErrorCategory.POLICY_DENIED,
        code: 'provider_content_filtered',
        message: 'The model provider blocked the request with its content filter',
      };
    }
    if (includesAny(bodyHint, CONTEXT_LENGTH_MARKERS)) {
      return {
        category: ErrorCategory.VALIDATION,
        code: 'provider_context_length_exceeded',
        message: 'The request exceeds the model context window',
      };
    }
    if (includesAny(bodyHint, QUOTA_MARKERS)) {
      return {
        category: ErrorCategory.PROVIDER_RATE_LIMITED,
        code: 'provider_quota_exhausted',
        message: 'The model provider quota is exhausted',
      };
    }
    return {
      category: ErrorCategory.VALIDATION,
      code: 'provider_rejected_request',
      message: 'The model provider rejected the request as invalid',
    };
  }
  if (status === 401) {
    return {
      category: ErrorCategory.AUTHENTICATION,
      code: 'provider_authentication_failed',
      message: 'The model provider rejected the configured credentials',
    };
  }
  if (status === 403) {
    if (includesAny(bodyHint, CONTENT_FILTER_MARKERS)) {
      return {
        category: ErrorCategory.POLICY_DENIED,
        code: 'provider_content_filtered',
        message: 'The model provider blocked the request with its content filter',
      };
    }
    return {
      category: ErrorCategory.AUTHORIZATION,
      code: 'provider_access_denied',
      message: 'The configured credentials are not allowed to use this model',
    };
  }
  if (status === 404) {
    return {
      category: ErrorCategory.NOT_FOUND,
      code: 'provider_model_not_found',
      message: 'The model or deployment was not found at the provider',
    };
  }
  if (status === 408 || status === 504) {
    return { category: ErrorCategory.TIMEOUT, code: 'provider_timeout', message: 'The model provider timed out' };
  }
  if (status === 413) {
    return {
      category: ErrorCategory.VALIDATION,
      code: 'provider_request_too_large',
      message: 'The request is too large for the model provider',
    };
  }
  if (status === 429) {
    if (includesAny(bodyHint, QUOTA_MARKERS)) {
      return {
        category: ErrorCategory.PROVIDER_RATE_LIMITED,
        code: 'provider_quota_exhausted',
        message: 'The model provider quota is exhausted',
      };
    }
    return {
      category: ErrorCategory.PROVIDER_RATE_LIMITED,
      code: 'provider_rate_limited',
      message: 'The model provider rate-limited the request',
    };
  }
  if (status === 529) {
    return {
      category: ErrorCategory.PROVIDER_UNAVAILABLE,
      code: 'provider_overloaded',
      message: 'The model provider is overloaded',
    };
  }
  if (status >= 500 || status === 409 || status === 424) {
    return {
      category: ErrorCategory.PROVIDER_UNAVAILABLE,
      code: 'provider_unavailable',
      message: 'The model provider is unavailable',
    };
  }
  return {
    category: ErrorCategory.VALIDATION,
    code: 'provider_rejected_request',
    message: 'The model provider rejected the request',
  };
}

/** Error class names (AI SDK `AI_*` names and DOM/Node errors) → classification. */
const NAME_CLASSIFICATIONS: ReadonlyArray<[RegExp, Classification]> = [
  [
    /^AI_(LoadAPIKeyError|LoadSettingError)$/,
    {
      category: ErrorCategory.AUTHENTICATION,
      code: 'provider_credentials_missing',
      message: 'The model provider credentials are missing or incomplete',
    },
  ],
  [
    /^AI_(InvalidPromptError|InvalidArgumentError|UnsupportedFunctionalityError|MessageConversionError|InvalidMessageRoleError|InvalidDataContentError)$/,
    {
      category: ErrorCategory.VALIDATION,
      code: 'model_request_invalid',
      message: 'The model request is not valid for this provider',
    },
  ],
  [
    /^AI_(NoOutputGeneratedError|NoContentGeneratedError|EmptyResponseBodyError|InvalidResponseDataError|JSONParseError|TypeValidationError|InvalidStreamPartError)$/,
    {
      category: ErrorCategory.PROVIDER_UNAVAILABLE,
      code: 'provider_invalid_response',
      message: 'The model provider returned an invalid response',
    },
  ],
];

export function classifyByName(name: string): Classification | null {
  for (const [pattern, classification] of NAME_CLASSIFICATIONS) {
    if (pattern.test(name)) return classification;
  }
  return null;
}

const NETWORK_TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** Node/undici network failures (`TypeError: fetch failed` with a coded cause). */
export function classifyNetworkCode(code: string | undefined, isFetchFailure: boolean): Classification | null {
  if (code && NETWORK_TIMEOUT_CODES.has(code)) {
    return { category: ErrorCategory.TIMEOUT, code: 'provider_timeout', message: 'The model provider timed out' };
  }
  if ((code && NETWORK_CODES.has(code)) || isFetchFailure) {
    return {
      category: ErrorCategory.PROVIDER_UNAVAILABLE,
      code: 'provider_unreachable',
      message: 'The model provider could not be reached',
    };
  }
  return null;
}
