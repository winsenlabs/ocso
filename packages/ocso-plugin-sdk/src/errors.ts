/**
 * Typed errors a plugin throws. OCSO maps every error that crosses a module
 * boundary onto one of these categories (validation → 400, authentication →
 * 401, authorization → 403, provider/timeout categories → retry, …).
 *
 * A plugin cannot share OCSO's internal error class (it is not published),
 * so the SDK marks errors instead: `pluginError()` returns a plain `Error`
 * carrying an `ocsoError` property, and the host's plugin loader translates
 * any error with that marker into its own typed error. Errors without the
 * marker pass through unchanged and surface as internal errors (500).
 */
export const ErrorCategory = {
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROVIDER_RATE_LIMITED: 'provider_rate_limited',
  TOOL_UNAVAILABLE: 'tool_unavailable',
  TOOL_REJECTED: 'tool_rejected',
  TIMEOUT: 'timeout',
  POLICY_DENIED: 'policy_denied',
  CAPACITY: 'capacity',
  INTERNAL: 'internal',
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

const CATEGORIES: ReadonlySet<string> = new Set(Object.values(ErrorCategory));

/** Categories that are safe to retry (possibly against a fallback target). */
export const RETRIABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  ErrorCategory.PROVIDER_UNAVAILABLE,
  ErrorCategory.PROVIDER_RATE_LIMITED,
  ErrorCategory.TIMEOUT,
  ErrorCategory.CAPACITY,
  ErrorCategory.TOOL_UNAVAILABLE,
]);

/** The marker the host reads. `details` must be safe to show to clients and to log: never secrets. */
export interface OcsoErrorMarker {
  readonly category: ErrorCategory;
  /** Stable machine-readable code, e.g. `webchat_token_invalid`. */
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/** An `Error` that carries the OCSO marker. */
export interface OcsoPluginError extends Error {
  readonly ocsoError: OcsoErrorMarker;
}

/** True for a known error category string. */
export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === 'string' && CATEGORIES.has(value);
}

/**
 * A typed error for OCSO: `throw pluginError('authentication', 'token_expired', 'The token has expired')`.
 * The marker is a non-enumerable own property, so it survives JSON logging
 * without duplicating details, and it is read by property access, never by
 * `instanceof`, so it works across copies of this package.
 */
export function pluginError(category: ErrorCategory, code: string, message: string, details?: Readonly<Record<string, unknown>>): OcsoPluginError {
  if (!isErrorCategory(category)) throw new TypeError(`pluginError: unknown error category "${String(category)}"`);
  if (typeof code !== 'string' || !code) throw new TypeError('pluginError: code must be a non-empty string');
  const error = new Error(message) as Error & { ocsoError: OcsoErrorMarker };
  error.name = 'OcsoPluginError';
  const marker: OcsoErrorMarker = Object.freeze(details === undefined ? { category, code } : { category, code, details });
  Object.defineProperty(error, 'ocsoError', { value: marker, enumerable: false, writable: false, configurable: false });
  return error;
}

/** True when `error` carries a well-formed OCSO marker (from this or any other copy of the SDK). */
export function isPluginError(error: unknown): error is OcsoPluginError {
  if (!(error instanceof Error)) return false;
  const marker = (error as { ocsoError?: unknown }).ocsoError;
  if (!marker || typeof marker !== 'object') return false;
  const { category, code, details } = marker as Record<string, unknown>;
  if (!isErrorCategory(category) || typeof code !== 'string' || !code) return false;
  return details === undefined || (typeof details === 'object' && details !== null);
}
