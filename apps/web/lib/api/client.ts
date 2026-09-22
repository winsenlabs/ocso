import 'server-only';
import { cookies } from 'next/headers';
import type { z } from 'zod';
import { SESSION_COOKIE } from '../session-cookie';
import { ApiError, apiErrorFromResponse, unreachableError } from './errors';

/**
 * Server-only fetch wrapper for the NestJS API (ADR-020). Server Components,
 * server actions and route handlers call the API with the session token from
 * the httpOnly cookie as a Bearer token. Responses are never cached.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export function apiBaseUrl(): string {
  return (process.env['API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiCallOptions {
  /** Explicit bearer token; defaults to the session cookie. `null` sends none. */
  token?: string | null | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

async function send(method: Method, path: string, body: unknown, options: ApiCallOptions): Promise<Response> {
  const headers = new Headers({ accept: 'application/json' });
  const token = options.token === undefined ? await readSessionToken() : options.token;
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers,
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw unreachableError(err);
  }
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res;
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
  async post<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('POST', path, body, options), schema);
  },
  async patch<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('PATCH', path, body, options), schema);
  },
  async put<S extends z.ZodType>(path: string, body: unknown, schema: S, options: ApiCallOptions = {}): Promise<z.infer<S>> {
    return parse(await send('PUT', path, body, options), schema);
  },
  /** For endpoints that answer 204 / an ignorable body. */
  async command(method: Method, path: string, body?: unknown, options: ApiCallOptions = {}): Promise<void> {
    const res = await send(method, path, body, options);
    await res.body?.cancel();
  },
};
