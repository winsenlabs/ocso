/**
 * Normalized error categories (docs/archive/specs/14 §5). Every error that crosses a module
 * boundary is one of these; raw provider/tool exceptions never leave adapters.
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

/** Categories that are safe to retry (possibly against a fallback target). */
export const RETRIABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  ErrorCategory.PROVIDER_UNAVAILABLE,
  ErrorCategory.PROVIDER_RATE_LIMITED,
  ErrorCategory.TIMEOUT,
  ErrorCategory.CAPACITY,
  ErrorCategory.TOOL_UNAVAILABLE,
]);

export class DomainError extends Error {
  constructor(
    readonly category: ErrorCategory,
    /** Stable machine-readable code, e.g. `invalid_control_transition`. */
    readonly code: string,
    message: string,
    /** Safe, non-secret structured details for clients and logs. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }

  get retriable(): boolean {
    return RETRIABLE_CATEGORIES.has(this.category);
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;

export const notFound = (entity: string, id: string): DomainError =>
  new DomainError(ErrorCategory.NOT_FOUND, `${entity}_not_found`, `${entity} ${id} not found`, {
    entity,
    id,
  });

export const forbidden = (action: string, reason = 'not permitted'): DomainError =>
  new DomainError(ErrorCategory.AUTHORIZATION, 'forbidden', `${action}: ${reason}`, { action });

export const conflict = (code: string, message: string): DomainError =>
  new DomainError(ErrorCategory.CONFLICT, code, message);

export const validation = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(ErrorCategory.VALIDATION, code, message, details);

export const policyDenied = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(ErrorCategory.POLICY_DENIED, code, message, details);
