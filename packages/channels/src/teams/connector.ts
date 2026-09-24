import { z } from 'zod';
import type { ChannelFetch } from '../contract/types.js';
import { isTimeoutError } from '../common/http.js';
import type { ResolvedTeamsConfig } from './config.js';
import { allowedServiceUrl } from './service-url.js';
import type { TeamsTokenClient, TokenFailure } from './token-client.js';

/**
 * Minimal Bot Connector client (Bot Framework REST API v3): posts one
 * activity to a conversation, or as a reply to an activity, with the bot's
 * client-credentials token. The service URL comes from the inbound activity,
 * so it is re-checked against the cloud's Bot Connector hosts right before
 * the token is sent there (SSRF guard, on top of the guarded egress).
 * HTTP 429 and 5xx are retried in place (Retry-After, or 1 s then 2 s …) up
 * to the channel's `retries`, as long as the wait is at most
 * `maxRetryAfterSeconds`; longer waits go back to the outbox. A 401 drops
 * the cached token and retries once with a fresh one. Network errors and
 * timeouts are not retried here: the connector may have accepted the
 * activity, so the outbox decides (at-least-once). Never logs.
 */

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type ConnectorResult =
  | { kind: 'ok'; status: number; body: Record<string, unknown> }
  /** The connector answered non-2xx; `code` is its error code (`ConversationNotFound`, …) when it sent one. */
  | { kind: 'error'; status: number; code?: string | undefined; message?: string | undefined; retryAfterSeconds?: number | undefined }
  | { kind: 'network'; timedOut: boolean }
  | { kind: 'token'; failure: TokenFailure }
  | { kind: 'blocked'; reason: string };

const ErrorBody = z.looseObject({ error: z.looseObject({ code: z.string().max(200).optional(), message: z.string().max(4_000).optional() }).optional() });

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return undefined;
  return Number(raw);
}

const retriable = (status: number) => status === 429 || status >= 500;

export class BotConnectorClient {
  constructor(
    private readonly config: ResolvedTeamsConfig,
    private readonly tokens: TeamsTokenClient,
    private readonly fetchImpl: ChannelFetch,
    private readonly sleep: Sleep = realSleep,
  ) {}

  /** `POST {serviceUrl}/v3/conversations/{id}/activities`. */
  async sendActivity(serviceUrl: string, conversationId: string, activity: Record<string, unknown>): Promise<ConnectorResult> {
    const base = allowedServiceUrl(serviceUrl, this.config.endpoints.serviceUrlHosts);
    if (!base) return { kind: 'blocked', reason: 'the conversation’s service URL is not a Bot Connector endpoint' };
    const path = `/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    return this.post(`${base}${path}`, activity);
  }

  private async post(url: string, body: Record<string, unknown>): Promise<ConnectorResult> {
    const { retries, maxRetryAfterSeconds } = this.config.settings;
    let refreshed = false;
    for (let attempt = 0; ; ) {
      const token = await this.tokens.token(this.config);
      if (!token.ok) return { kind: 'token', failure: token };
      const result = await this.once(url, body, token.token);
      if (result.kind === 'error' && result.status === 401 && !refreshed) {
        // The token may have been revoked or rotated: get a new one and try once more.
        refreshed = true;
        this.tokens.invalidate(this.config);
        continue;
      }
      if (result.kind !== 'error' || !retriable(result.status) || attempt >= retries) return result;
      const wait = result.retryAfterSeconds ?? 2 ** attempt;
      if (wait > maxRetryAfterSeconds) return result;
      attempt += 1;
      await this.sleep(wait * 1000);
    }
  }

  private async once(url: string, body: Record<string, unknown>, token: string): Promise<ConnectorResult> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.settings.requestTimeoutMs),
      });
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
    if (response.ok) return { kind: 'ok', status: response.status, body: json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {} };
    const error = ErrorBody.safeParse(json);
    const detail = error.success ? error.data.error : undefined;
    return { kind: 'error', status: response.status, code: detail?.code, message: detail?.message, retryAfterSeconds: retryAfter(response) };
  }
}
