import { ChatApiError, type ChatApi, type SessionBody } from './api.js';
import { createUtf8Decoder } from './sse.js';
import type { ChatContext, ChatStorage } from './types.js';

/**
 * Visitor session: the channel-bound visitor token (`wcv1…`) lives in the
 * app's storage so a reload resumes the same conversation. Every start renews
 * it (sliding expiry). Channels in `client`/`user` mode require a session pass
 * minted by the host's server (or a verified user token) on every exchange, so
 * the getters are called before each `POST /session`, and once more when the
 * server says the pass is missing, expired or already used.
 */

interface StoredSession {
  token: string;
  expiresAt: string;
  authenticated: boolean;
  /**
   * The signed-in user the session was opened for, read (unverified) from the user token or session pass sent:
   * a string when known, null when none was sent, absent when unknown (an opaque token, or an older stored session).
   */
  subject?: string | null | undefined;
}

export interface SessionInfo {
  token: string;
  authenticated: boolean;
}

export interface SessionAuth {
  getSessionPass?: (() => Promise<string>) | undefined;
  getUserToken?: (() => Promise<string | null>) | undefined;
  context?: ChatContext | undefined;
}

/**
 * 401/403 codes that a fresh session pass or user token can fix (OCSO:
 * session_pass_required|invalid|expired|used, user_token_required|invalid).
 */
export function isCredentialError(err: unknown): err is ChatApiError {
  return err instanceof ChatApiError && (err.status === 401 || err.status === 403) && /^(session_pass|user_token|webchat_session_pass|webchat_user_token)/.test(err.code);
}

export class VisitorSession {
  private current: StoredSession | null = null;
  private inflight: Promise<SessionInfo> | null = null;
  private readonly key: string;
  /**
   * The user token handed to `identify()`, kept in memory only (never in storage) so later renewals
   * re-prove the user: OCSO's `user` mode requires a user token (or pass) on every session exchange.
   */
  private identified: string | null = null;

  constructor(
    private readonly api: ChatApi,
    private readonly storage: ChatStorage,
    private readonly auth: SessionAuth,
  ) {
    this.key = `ocso.chat.${api.publishableKey}.session`;
  }

  get token(): string | null {
    return this.current?.token ?? null;
  }

  get authenticated(): boolean {
    return this.current?.authenticated ?? false;
  }

  /** A usable token from an earlier visit exists (the visitor may have a conversation to resume). */
  async hasStored(): Promise<boolean> {
    return (await this.stored()) !== null;
  }

  /** Create or renew the session (single-flight). */
  start(): Promise<SessionInfo> {
    this.inflight ??= (async () => {
      const stored = this.current ?? (await this.stored());
      return this.exchange(stored ? { visitorToken: stored.token } : {});
    })().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** The API answered 401: the token expired or was revoked. */
  refresh(): Promise<SessionInfo> {
    return this.start();
  }

  /** Exchange a user token (verified by OCSO) for an identified visitor token. */
  async identify(userToken: string): Promise<SessionInfo> {
    const stored = this.current ?? (await this.stored());
    const info = await this.exchange({ ...(stored ? { visitorToken: stored.token } : {}), userToken });
    this.identified = userToken;
    return info;
  }

  /** Forget this visitor (e.g. the customer signed out) and start a fresh session. */
  async reset(): Promise<SessionInfo> {
    this.current = null;
    this.identified = null;
    await Promise.resolve(this.storage.remove(this.key)).catch(() => undefined);
    return this.exchange({});
  }

  private async credentials(base: SessionBody): Promise<SessionBody> {
    const body: SessionBody = { ...base };
    if (this.auth.getSessionPass) body.sessionPass = await this.auth.getSessionPass();
    if (!body.userToken && this.auth.getUserToken) {
      const userToken = await this.auth.getUserToken();
      if (userToken) body.userToken = userToken;
    }
    if (!body.userToken && this.identified) body.userToken = this.identified;
    if (this.auth.context && Object.keys(this.auth.context).length) body.context = this.auth.context;
    return body;
  }

  private async exchange(request: SessionBody): Promise<SessionInfo> {
    let res;
    let base = request;
    let body: SessionBody = request;
    try {
      body = await this.forgetOtherUser(await this.credentials(request));
      // A visitor forgotten for another user stays forgotten on the retries below.
      if (!body.visitorToken) base = withoutVisitor(request);
      res = await this.api.session(body);
    } catch (err) {
      // The identified user's token went stale (expired): drop it. Anonymous channels keep the identity the
      // visitor token already carries; user-mode channels then answer user_token_required (call identify again).
      if (!base.userToken && this.identified && isCredentialError(err) && /user_token_invalid$/.test(err.code)) {
        this.identified = null;
        return this.exchange(base);
      }
      // A pass is single-use and short-lived: one fresh try when the server rejects it.
      if (!isCredentialError(err) || (!this.auth.getSessionPass && !this.auth.getUserToken)) throw err;
      // A user token the caller handed in (identify) will not get better on a retry.
      if (base.userToken && /user_token_invalid$/.test(err.code)) throw err;
      body = await this.forgetOtherUser(await this.credentials(base));
      res = await this.api.session(body);
    }
    // A renewal that sent no user credential keeps the user the visitor token already carries (anonymous mode).
    const hint = subjectHint(body);
    const subject = hint === null && body.visitorToken ? (await this.storedFor(body.visitorToken))?.subject : hint;
    this.current = { token: res.token, expiresAt: res.expiresAt, authenticated: res.authenticated, subject };
    try {
      await this.storage.set(this.key, JSON.stringify(this.current));
    } catch {
      // Quota or blocked storage: the in-memory session still works for this run.
    }
    return { token: res.token, authenticated: res.authenticated };
  }

  /**
   * A different signed-in user (or none, where the host says who is signed in) must not continue the stored
   * visitor: on a shared browser that is someone else's conversation. Drop the stored session and send no
   * visitor token. This is only a hint read from unverified tokens: OCSO itself never carries a visitor over
   * to another verified user.
   */
  private async forgetOtherUser(body: SessionBody): Promise<SessionBody> {
    if (!body.visitorToken) return body;
    const was = (await this.storedFor(body.visitorToken))?.subject;
    if (typeof was !== 'string') return body;
    const now = subjectHint(body);
    const hostSaysWho = Boolean(this.auth.getUserToken || this.auth.getSessionPass || this.identified);
    if (now === undefined || now === was || (now === null && !hostSaysWho)) return body;
    this.current = null;
    await Promise.resolve(this.storage.remove(this.key)).catch(() => undefined);
    return withoutVisitor(body);
  }

  /** The session (in memory or stored) that issued `token`. */
  private async storedFor(token: string): Promise<StoredSession | null> {
    const stored = this.current ?? (await this.stored());
    return stored?.token === token ? stored : null;
  }

  private async stored(): Promise<StoredSession | null> {
    try {
      const raw = await this.storage.get(this.key);
      const parsed = raw ? (JSON.parse(raw) as Partial<StoredSession>) : null;
      if (!parsed || typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return null;
      if (!(Date.parse(parsed.expiresAt) > Date.now())) return null;
      const subject = typeof parsed.subject === 'string' || parsed.subject === null ? parsed.subject : undefined;
      return { token: parsed.token, expiresAt: parsed.expiresAt, authenticated: parsed.authenticated === true, subject };
    } catch {
      return null;
    }
  }
}

function withoutVisitor(body: SessionBody): SessionBody {
  const rest = { ...body };
  delete rest.visitorToken;
  return rest;
}

/**
 * Who a session exchange signs in, read without verification from the user token (a JWT's `sub`) or the session
 * pass (`wsp1.<claims>.<mac>`, its `sub`): a string, null when neither was sent (or the pass names no user), or
 * undefined when a credential was sent but cannot be read. Only a hint for keeping users apart on one device.
 */
export function subjectHint(body: Pick<SessionBody, 'userToken' | 'sessionPass'>): string | null | undefined {
  if (body.userToken) return claimSub(body.userToken, /^[^.]+\.([^.]+)\.[^.]*$/);
  if (body.sessionPass) {
    const sub = claimSub(body.sessionPass, /^wsp1\.([^.]+)\.[^.]+$/);
    return sub === undefined ? undefined : sub;
  }
  return null;
}

function claimSub(token: string, shape: RegExp): string | null | undefined {
  const payload = shape.exec(token)?.[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as { sub?: unknown };
    if (!claims || typeof claims !== 'object') return undefined;
    return typeof claims.sub === 'string' ? claims.sub : claims.sub === undefined ? null : undefined;
  } catch {
    return undefined;
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url -> UTF-8 text without atob (absent on older React Native runtimes). */
function decodeBase64Url(value: string): string {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of value.replace(/=+$/, '')) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Error('not base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return createUtf8Decoder().decode(Uint8Array.from(bytes));
}
