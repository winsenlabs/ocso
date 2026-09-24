import { z } from 'zod';
import type { ChannelFetch } from '../contract/types.js';
import { isTimeoutError } from '../common/http.js';
import type { ResolvedSlackConfig } from './config.js';

/**
 * Minimal Slack Web API client: JSON POSTs with the bot token as a Bearer
 * credential, no redirects, bounded time. HTTP 429 is retried in place after
 * `Retry-After` (Slack's per-method, per-channel limits are short) up to the
 * channel's `rateLimitRetries`, as long as the wait is at most
 * `maxRetryAfterSeconds`; longer waits are returned so the outbox backs off.
 * Never logs; the token only ever travels in the Authorization header.
 */

export type SlackResult =
  | { kind: 'ok'; body: Record<string, unknown>; scopes: string[] | null }
  /** Slack answered `ok: false` (HTTP 200) or a non-2xx status; `error` is Slack's code (`channel_not_found`, …). */
  | { kind: 'error'; status: number; error: string; retryAfterSeconds?: number | undefined }
  | { kind: 'network'; timedOut: boolean };

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SlackBody = z.looseObject({ ok: z.boolean(), error: z.string().optional() });

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return undefined;
  return Number(raw);
}

export class SlackWebApi {
  constructor(
    private readonly config: ResolvedSlackConfig,
    private readonly fetchImpl: ChannelFetch,
    private readonly sleep: Sleep = realSleep,
  ) {}

  /** `POST {apiBaseUrl}/{method}` with a JSON body, retrying HTTP 429 in place when the wait is short. */
  async call(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    const { rateLimitRetries, maxRetryAfterSeconds } = this.config.settings;
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.once(method, body);
      const wait = result.kind === 'error' && result.status === 429 ? (result.retryAfterSeconds ?? 1) : null;
      if (wait === null || attempt >= rateLimitRetries || wait > maxRetryAfterSeconds) return result;
      await this.sleep(wait * 1000);
    }
  }

  private async once(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.settings.apiBaseUrl}/${method}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.config.secrets.botToken}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.settings.requestTimeoutMs),
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
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const parsed = SlackBody.safeParse(json);
    if (response.status === 429) return { kind: 'error', status: 429, error: parsed.success ? (parsed.data.error ?? 'ratelimited') : 'ratelimited', retryAfterSeconds: retryAfter(response) };
    if (!response.ok) return { kind: 'error', status: response.status, error: parsed.success ? (parsed.data.error ?? `http_${response.status}`) : `http_${response.status}` };
    if (!parsed.success) return { kind: 'error', status: response.status, error: 'invalid_response' };
    if (!parsed.data.ok) return { kind: 'error', status: response.status, error: parsed.data.error ?? 'unknown_error', retryAfterSeconds: retryAfter(response) };
    const scopes = response.headers.get('x-oauth-scopes');
    return { kind: 'ok', body: parsed.data, scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean) };
  }
}
