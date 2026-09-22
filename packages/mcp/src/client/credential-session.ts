import type { AuthProvider } from '@modelcontextprotocol/client';
import type { FetchFn } from '../egress/guarded-fetch.js';
import { McpCredentialError, McpOAuthError } from '../errors.js';
import { refreshOAuthTokens } from '../oauth/refresh.js';
import { isExpiring, parseClientInformation, parseOAuthTokenState, serializeOAuthTokenState } from '../oauth/token-state.js';
import type { CredentialPort, McpConnectionTarget, McpOAuthClientInformation, StoredOAuthTokenState } from '../types.js';

type ClientCreds = Pick<McpOAuthClientInformation, 'clientId' | 'clientSecret' | 'clientSecretExpiresAt'>;

/** RFC 9110 token; admins may name any credential header except transport/protocol-owned ones. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'accept',
  'mcp-protocol-version',
  'mcp-session-id',
  'mcp-method',
  'mcp-name',
  'idempotency-key',
  'x-ocso-customer-claims',
]);

/**
 * Per-client credential handling. Secrets are resolved lazily through the
 * CredentialPort and only ever written onto outbound HTTP requests to the
 * connection's own origin. OAuth access tokens are refreshed proactively
 * (near expiry) and on 401 (single-flight), and every refresh is persisted
 * through `CredentialPort.onTokensRefreshed`.
 */
export class CredentialSession {
  private headerValue: string | null = null;
  private tokens: StoredOAuthTokenState | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly target: McpConnectionTarget,
    private readonly credentials: CredentialPort,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether requests carry credentials (distinguishes "token rejected" from "auth required"). */
  get sendsCredentials(): boolean {
    return this.target.auth.strategy !== 'NONE';
  }

  /** Resolved secret values currently held, for redaction of any text leaving trusted code. */
  secrets(): string[] {
    const t = this.tokens;
    return [this.headerValue, t?.accessToken, t?.refreshToken].filter((s): s is string => typeof s === 'string' && s.length >= 4);
  }

  /** The SDK auth hook: `token()` before every request, `onUnauthorized()` once per 401 before a single retry. */
  authProvider(): AuthProvider | undefined {
    const auth = this.target.auth;
    if (auth.strategy === 'NONE') return undefined;
    if (auth.strategy === 'HEADER') {
      return {
        token: async () => {
          await this.ensureHeader();
          return undefined; // header is injected by wrapFetch (custom header names)
        },
        onUnauthorized: async () => {
          this.headerValue = null; // the admin may have rotated it: re-resolve before the retry
          await this.ensureHeader();
        },
      };
    }
    return {
      token: async () => this.accessToken(),
      onUnauthorized: async () => this.refresh(true),
    };
  }

  /** Inject the HEADER-strategy credential on requests to the connection's own origin. */
  wrapFetch(fetchFn: FetchFn): FetchFn {
    const auth = this.target.auth;
    if (auth.strategy !== 'HEADER') return fetchFn;
    const origin = new URL(this.target.url).origin;
    return async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== origin) return fetchFn(input, init);
      const value = await this.ensureHeader();
      const headers = new Headers(init?.headers);
      headers.set(auth.headerName, value);
      return fetchFn(input, { ...init, headers });
    };
  }

  private async ensureHeader(): Promise<string> {
    const auth = this.target.auth;
    if (auth.strategy !== 'HEADER' || !HEADER_NAME.test(auth.headerName) || RESERVED_HEADERS.has(auth.headerName.toLowerCase())) {
      throw new McpCredentialError('malformed');
    }
    if (this.headerValue !== null) return this.headerValue;
    const raw = (await this.resolve(auth.tokenRef)).trim();
    if (!raw || /[\r\n]/.test(raw)) throw new McpCredentialError('malformed');
    // A bare token placed in `Authorization` gets the Bearer scheme; anything with a scheme is sent verbatim.
    this.headerValue = auth.headerName.toLowerCase() === 'authorization' && !/\s/.test(raw) ? `Bearer ${raw}` : raw;
    return this.headerValue;
  }

  private async loadTokens(): Promise<StoredOAuthTokenState> {
    const auth = this.target.auth;
    if (auth.strategy !== 'OAUTH') throw new McpCredentialError('malformed');
    if (this.tokens) return this.tokens;
    const state = parseOAuthTokenState(await this.resolve(auth.tokenRef));
    // Never send a token minted by a different authorization server than the one this connection trusts.
    if (state.issuer !== auth.issuer) throw new McpCredentialError('issuer_mismatch');
    this.tokens = state;
    return state;
  }

  private async accessToken(): Promise<string> {
    const state = await this.loadTokens();
    if (isExpiring(state, this.now()) && state.refreshToken) await this.refresh(false);
    return (this.tokens ?? state).accessToken;
  }

  private refresh(force: boolean): Promise<void> {
    this.refreshing ??= this.doRefresh(force).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(force: boolean): Promise<void> {
    const auth = this.target.auth;
    if (auth.strategy !== 'OAUTH') return;
    const state = await this.loadTokens();
    if (!force && !isExpiring(state, this.now())) return;
    if (!state.refreshToken) throw new McpOAuthError('refresh_unavailable');
    const client = await this.clientCredentials();
    const fresh = await refreshOAuthTokens({
      issuer: auth.issuer,
      clientInformation: client,
      refreshToken: state.refreshToken,
      resource: state.resource,
      fetchFn: this.fetchFn,
    });
    const next: StoredOAuthTokenState = {
      ...fresh,
      refreshToken: fresh.refreshToken ?? state.refreshToken,
      issuer: auth.issuer,
      ...(state.resource ? { resource: state.resource } : {}),
    };
    this.tokens = next;
    await this.credentials.onTokensRefreshed({
      connectionId: this.target.id,
      tokenRef: auth.tokenRef,
      issuer: auth.issuer,
      state: next,
      serialized: serializeOAuthTokenState(next),
    });
  }

  private async clientCredentials(): Promise<ClientCreds> {
    const auth = this.target.auth;
    if (auth.strategy !== 'OAUTH') throw new McpCredentialError('malformed');
    if (!auth.clientInfoRef) return { clientId: auth.clientId };
    const info = parseClientInformation(await this.resolve(auth.clientInfoRef));
    if (info.issuer !== auth.issuer || info.clientId !== auth.clientId) throw new McpCredentialError('issuer_mismatch');
    return info;
  }

  private async resolve(ref: string): Promise<string> {
    try {
      return await this.credentials.resolve(ref);
    } catch {
      throw new McpCredentialError('unresolvable');
    }
  }
}
