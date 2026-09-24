import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChannelFetch } from '../contract/types.js';
import { isTimeoutError } from '../common/http.js';
import { safeProviderText } from '../common/redact.js';
import type { ResolvedTeamsConfig } from './config.js';

/**
 * Bot → Bot Connector access tokens: OAuth 2.0 client credentials against
 * Microsoft Entra (`<login host>/<tenant id | botframework.com>/oauth2/v2.0/token`,
 * scope `https://api.botframework.com/.default`). Tokens (about an hour) are
 * cached per endpoint + app id + secret until five minutes before expiry;
 * concurrent callers share one request. The client secret travels only in
 * the form body, and provider text is redacted before it is surfaced.
 */

const REFRESH_MARGIN_MS = 5 * 60_000;
const MIN_LIFETIME_S = 60;
const MAX_CACHED = 256;

const TokenResponse = z.looseObject({ access_token: z.string().min(1), expires_in: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]) });
const TokenError = z.looseObject({ error: z.string().optional(), error_description: z.string().optional() });

export type TokenFailure = {
  ok: false;
  errorCode: 'auth_failed' | 'provider_unavailable' | 'rate_limited' | 'timeout' | 'network_error';
  message: string;
  retriable: boolean;
};
export type TokenResult = { ok: true; token: string; expiresAt: number } | TokenFailure;

export class TeamsTokenClient {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<TokenResult>>();

  constructor(
    private readonly fetchImpl: ChannelFetch,
    private readonly clock: () => number,
  ) {}

  private key(config: ResolvedTeamsConfig): string {
    const secret = createHash('sha256').update(config.secrets.appPassword).digest('hex');
    return `${config.endpoints.tokenUrl}\n${config.endpoints.scope}\n${config.settings.appId}\n${secret}`;
  }

  /** A valid token: cached, or requested now (always requested with `fresh`). */
  async token(config: ResolvedTeamsConfig, options: { fresh?: boolean } = {}): Promise<TokenResult> {
    const key = this.key(config);
    const cached = this.cache.get(key);
    if (!options.fresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > this.clock()) return { ok: true, ...cached };
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.request(config)
      .then((result) => {
        if (result.ok) {
          if (this.cache.size >= MAX_CACHED) this.cache.clear();
          this.cache.set(key, { token: result.token, expiresAt: result.expiresAt });
        }
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Forget a token the Bot Connector refused (401), so the next call requests a new one. */
  invalidate(config: ResolvedTeamsConfig): void {
    this.cache.delete(this.key(config));
  }

  private async request(config: ResolvedTeamsConfig): Promise<TokenResult> {
    const secrets = [config.secrets.appPassword];
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: config.settings.appId, client_secret: config.secrets.appPassword, scope: config.endpoints.scope });
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(config.endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(config.settings.requestTimeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const timedOut = isTimeoutError(error);
      return { ok: false, errorCode: timedOut ? 'timeout' : 'network_error', message: timedOut ? 'Microsoft Entra did not answer in time' : 'could not reach Microsoft Entra', retriable: true };
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.ok) {
      const parsed = TokenResponse.safeParse(json);
      if (!parsed.success) return { ok: false, errorCode: 'provider_unavailable', message: 'Microsoft Entra answered without an access token', retriable: true };
      return { ok: true, token: parsed.data.access_token, expiresAt: this.clock() + Math.max(parsed.data.expires_in, MIN_LIFETIME_S) * 1000 };
    }
    if (response.status === 429) return { ok: false, errorCode: 'rate_limited', message: 'Microsoft Entra rate-limited the token request', retriable: true };
    if (response.status >= 500) return { ok: false, errorCode: 'provider_unavailable', message: `Microsoft Entra answered HTTP ${response.status}`, retriable: true };
    const error = TokenError.safeParse(json);
    // AADSTS codes lead the description ("AADSTS7000215: Invalid client secret provided. …"): keep its first line.
    const detail = error.success ? safeProviderText(error.data.error_description?.split(/\r?\n/)[0] ?? error.data.error, secrets, 200) : '';
    return { ok: false, errorCode: 'auth_failed', message: `Microsoft Entra refused the app credentials (HTTP ${response.status})${detail ? `: ${detail}` : ''}`, retriable: false };
  }
}
