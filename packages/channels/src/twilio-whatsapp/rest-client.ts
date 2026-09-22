import { z } from 'zod';
import { isTimeoutError } from '../common/http.js';
import type { ResolvedTwilioConfig } from './config.js';

/**
 * Minimal Twilio REST client (2010-04-01 API). Form-encoded requests, HTTP
 * Basic auth (API key SID + secret, else Account SID + auth token), no
 * redirects, bounded time. Returns discriminated results; never logs and never
 * puts credentials anywhere but the Authorization header.
 */

export interface TwilioError {
  code?: number | undefined;
  message?: string | undefined;
  moreInfo?: string | undefined;
}

export type TwilioResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'error'; status: number; error: TwilioError }
  | { kind: 'network'; timedOut: boolean };

const TwilioErrorBody = z.looseObject({
  code: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
  message: z.string().optional(),
  more_info: z.string().optional(),
});

export function parseTwilioError(bodyText: string): TwilioError {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return {};
  }
  const parsed = TwilioErrorBody.safeParse(json);
  return parsed.success ? { code: parsed.data.code, message: parsed.data.message, moreInfo: parsed.data.more_info } : {};
}

/** `Authorization: Basic …` for REST calls (and for media on the API host). */
export function basicAuthorization(config: ResolvedTwilioConfig): string {
  const { apiKeySid, accountSid } = config.settings;
  const [user, password] = apiKeySid && config.secrets.apiKeySecret ? [apiKeySid, config.secrets.apiKeySecret] : [accountSid, config.secrets.authToken];
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

export class TwilioRestClient {
  constructor(
    private readonly config: ResolvedTwilioConfig,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** `${apiBaseUrl}/2010-04-01/Accounts/{AccountSid}[/…].json` */
  accountUrl(...segments: string[]): string {
    const path = [this.config.settings.accountSid, ...segments].map(encodeURIComponent).join('/');
    return `${this.config.settings.apiBaseUrl}/2010-04-01/Accounts/${path}.json`;
  }

  postForm(url: string, form: URLSearchParams): Promise<TwilioResult> {
    return this.call(url, { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  getJson(url: string, authorization = basicAuthorization(this.config)): Promise<TwilioResult> {
    return this.call(url, { method: 'GET' }, authorization);
  }

  /** JSON body (the Content API; the 2010-04-01 API is form-encoded). */
  postJson(url: string, body: unknown): Promise<TwilioResult> {
    return this.call(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  }

  /** DELETE; a 204 answers `{ kind: 'ok', body: {} }`. */
  delete(url: string): Promise<TwilioResult> {
    return this.call(url, { method: 'DELETE' });
  }

  private async call(
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
    authorization = basicAuthorization(this.config),
  ): Promise<TwilioResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...init.headers, accept: 'application/json', authorization },
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
    if (!response.ok) return { kind: 'error', status: response.status, error: parseTwilioError(text) };
    try {
      return { kind: 'ok', status: response.status, body: text ? JSON.parse(text) : {} };
    } catch {
      return { kind: 'error', status: response.status, error: { message: 'response was not valid JSON' } };
    }
  }
}
