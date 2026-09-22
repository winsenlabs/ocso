import { z } from 'zod';
import { isTimeoutError } from '../common/http.js';
import type { ChannelFetch } from '../contract/types.js';

/**
 * Minimal Meta Graph API client. Returns discriminated results instead of
 * throwing so callers map failures explicitly. It never logs, and it never
 * places the access token anywhere but the Authorization header.
 */

export interface GraphClientOptions {
  baseUrl: string;
  version: string;
  accessToken: string;
  timeoutMs: number;
  fetch: ChannelFetch;
}

export interface GraphError {
  code?: number | undefined;
  type?: string | undefined;
  message?: string | undefined;
  details?: string | undefined;
  traceId?: string | undefined;
}

export type GraphResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'error'; status: number; error: GraphError }
  | { kind: 'network'; timedOut: boolean };

const GraphErrorBody = z.object({
  error: z.object({
    code: z.union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)]).optional(),
    type: z.string().optional(),
    message: z.string().optional(),
    error_data: z.object({ details: z.string().optional() }).optional(),
    fbtrace_id: z.string().optional(),
  }),
});

export function parseGraphError(bodyText: string): GraphError {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return {};
  }
  const parsed = GraphErrorBody.safeParse(json);
  if (!parsed.success) return {};
  const { code, type, message, error_data, fbtrace_id } = parsed.data.error;
  return { code, type, message, details: error_data?.details, traceId: fbtrace_id };
}

/** Path segments interpolated into Graph URLs must be plain ids. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSafePathSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

export class GraphClient {
  constructor(private readonly options: GraphClientOptions) {}

  get origin(): string {
    return new URL(this.options.baseUrl).origin;
  }

  get accessToken(): string {
    return this.options.accessToken;
  }

  get timeoutMs(): number {
    return this.options.timeoutMs;
  }

  endpoint(...segments: string[]): string {
    if (!segments.every(isSafePathSegment)) throw new Error('unsafe Graph API path segment');
    return `${this.options.baseUrl}/${this.options.version}/${segments.join('/')}`;
  }

  getJson(...segments: string[]): Promise<GraphResult> {
    return this.call(this.endpoint(...segments), { method: 'GET' });
  }

  /** GET with query parameters (template lists, single fields). */
  getWithQuery(segments: readonly string[], query: Readonly<Record<string, string>>): Promise<GraphResult> {
    return this.call(`${this.endpoint(...segments)}?${new URLSearchParams(query).toString()}`, { method: 'GET' });
  }

  /** A paging `next` URL Meta returned; refused unless it is on the configured Graph origin. */
  getPage(url: string): Promise<GraphResult> {
    if (!URL.canParse(url) || new URL(url).origin !== this.origin) return Promise.resolve({ kind: 'error', status: 400, error: { message: 'paging URL is not on the Graph API origin' } });
    return this.call(url, { method: 'GET' });
  }

  deleteWithQuery(segments: readonly string[], query: Readonly<Record<string, string>>): Promise<GraphResult> {
    return this.call(`${this.endpoint(...segments)}?${new URLSearchParams(query).toString()}`, { method: 'DELETE' });
  }

  postJson(segments: readonly string[], body: unknown): Promise<GraphResult> {
    return this.call(this.endpoint(...segments), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  postForm(segments: readonly string[], form: FormData): Promise<GraphResult> {
    return this.call(this.endpoint(...segments), { method: 'POST', body: form });
  }

  private async call(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | FormData },
  ): Promise<GraphResult> {
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.options.accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return { kind: 'network', timedOut: isTimeoutError(error) };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return { kind: 'network', timedOut: isTimeoutError(error) };
    }
    if (!response.ok) return { kind: 'error', status: response.status, error: parseGraphError(text) };
    try {
      return { kind: 'ok', status: response.status, body: text ? JSON.parse(text) : {} };
    } catch {
      return { kind: 'error', status: response.status, error: { message: 'response was not valid JSON' } };
    }
  }
}
