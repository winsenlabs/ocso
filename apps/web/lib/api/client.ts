import 'server-only';
import { cookies } from 'next/headers';
import type { z } from 'zod';
import { sessionCookieValue } from '../session-cookie';
import { ApiError, apiErrorFromResponse, unreachableError } from './errors';

/**
 * Server-only fetch wrapper for the NestJS API (ADR-020). Server Components,
 * server actions and route handlers call the API with the Better Auth session
 * from the httpOnly cookie as a Bearer token. Responses are never cached.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * A read that cannot reach the API is retried for about five seconds: the api
 * container restarts on every upgrade, and a page loaded during it should
 * render rather than show "could not load". Only GET is retried (the only
 * method OCSO can repeat safely), and only when the request never got a
 * response — a reply of any status is returned as it is.
 */
const RETRY_BACKOFF_MS = [200, 500, 1_000, 1_500, 2_000];

export function apiBaseUrl(): string {
  return (process.env['API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiCallOptions {
  /** Explicit bearer token; defaults to the session cookie. `null` sends none. */
  token?: string | null | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Extra request headers (e.g. the verified client IP on login). */
  headers?: Readonly<Record<string, string>> | undefined;
}

/** The Better Auth session (signed token from the httpOnly cookie), forwarded to the API as Bearer (ADR-025). */
export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return sessionCookieValue((name) => jar.get(name)?.value);
}

async function send(method: Method, path: string, body: unknown, options: ApiCallOptions): Promise<Response> {
  const headers = new Headers({ accept: 'application/json' });
  const token = options.token === undefined ? await readSessionToken() : options.token;
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

  const attempts = method === 'GET' && !options.signal ? RETRY_BACKOFF_MS.length + 1 : 1;
  let res: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      res = await fetch(`${apiBaseUrl()}${path}`, {
        method,
        headers,
        cache: 'no-store',
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      break;
    } catch (err) {
      // Only a connection that never landed is repeated: a timeout means the API may be working on it.
      const connectionFailed = err instanceof TypeError;
      if (!connectionFailed || attempt === attempts - 1) throw unreachableError(err);
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt] ?? 400));
    }
  }
  if (!res!.ok) throw await apiErrorFromResponse(res!);
  return res!;
}

async function parse<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      status: 502,
      category: 'internal',
      code: 'invalid_api_response',
      message: 'The OCSO API returned an unexpected response.',
    });
  }
  return parsed.data;
}

/** Typed API calls. Each response is validated at the boundary (build rule §19). */
export const api = {
  async get<S extends z.ZodType>(path: string, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('GET', path, undefined, options), schema);
  },
  /** GET that also returns the response headers (e.g. x-ocso-audit-source). */
  async getWithHeaders<S extends z.ZodType>(path: string, schema: S, options: ApiCallOptions = {}): Promise<{ data: z.infer<S>; headers: Headers }> {
    const res = await send('GET', path, undefined, options);
    return { data: await parse(res, schema), headers: res.headers };
  },
  async post<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('POST', path, body, options), schema);
  },
  async patch<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('PATCH', path, body, options), schema);
  },
  async put<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('PUT', path, body, options), schema);
  },
  /** DELETE with a body and a typed answer (e.g. 202 `{ proposal }` when the delete needs approval). */
  async delete<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('DELETE', path, body, options), schema);
  },
  /** For endpoints that answer 204 / an ignorable body. */
  async command(method: Method, path: string, body?: unknown, options: ApiCallOptions = {}): Promise<void> {
    const res = await send(method, path, body, options);
    await res.body?.cancel();
  },
};
