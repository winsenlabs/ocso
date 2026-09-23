import type { ErrorCategory } from '@ocso/domain';

/** Category of a failed API call: the API's docs/14 §5 categories plus transport failure. */
export type ApiErrorCategory = ErrorCategory | 'unreachable';

export interface ApiErrorInit {
  status: number;
  category: ApiErrorCategory;
  code: string;
  message: string;
  correlationId?: string | null | undefined;
}

/** Typed error for every non-2xx (or unreachable) NestJS API response. */
export class ApiError extends Error {
  readonly status: number;
  readonly category: ApiErrorCategory;
  readonly code: string;
  readonly correlationId: string | null;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.category = init.category;
    this.code = init.code;
    this.correlationId = init.correlationId ?? null;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** The endpoint does not exist on this API build (not yet implemented). */
  get isMissingEndpoint(): boolean {
    return this.status === 404 && this.code === 'http_404';
  }
}

interface ErrorBody {
  error?: { category?: unknown; code?: unknown; message?: unknown; correlationId?: unknown };
}

export async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const e = body?.error;
  return new ApiError({
    status: res.status,
    category: typeof e?.category === 'string' ? (e.category as ErrorCategory) : fallbackCategory(res.status),
    code: typeof e?.code === 'string' ? e.code : `http_${res.status}`,
    message: typeof e?.message === 'string' && e.message ? e.message : `Request failed (${res.status})`,
    correlationId: typeof e?.correlationId === 'string' ? e.correlationId : null,
  });
}

export function unreachableError(cause: unknown): ApiError {
  const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
  return new ApiError({
    status: timedOut ? 504 : 503,
    category: timedOut ? 'timeout' : 'unreachable',
    code: timedOut ? 'api_timeout' : 'api_unreachable',
    message: timedOut ? 'The OCSO API did not respond in time.' : 'The OCSO API is not reachable.',
  });
}

function fallbackCategory(status: number): ErrorCategory {
  if (status === 400) return 'validation';
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'internal';
}

/** Message safe to show a signed-in user; never includes raw exception text. */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Try again.';
}
