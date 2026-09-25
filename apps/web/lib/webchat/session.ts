import type { WebChatApi } from './api';

/**
 * Visitor session: the channel-bound visitor token lives in the widget
 * iframe's own storage (OCSO's origin, partitioned per host site by modern
 * browsers), so a reload resumes the same conversation. Every start renews
 * the token (sliding expiry); a host-site JWT upgrades it to an identified
 * customer. Storage failures (private mode, blocked storage) degrade to an
 * in-memory session for this page view.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserStorage(): KeyValueStorage {
  const memory = new Map<string, string>();
  const fallback: KeyValueStorage = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  };
  try {
    const storage = window.localStorage;
    const probe = '__ocso_webchat_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return fallback;
  }
}

/** Resolves browserStorage() on first use, so the session can be constructed during SSR. */
export function lazyBrowserStorage(): KeyValueStorage {
  let resolved: KeyValueStorage | null = null;
  const get = () => (resolved ??= browserStorage());
  return {
    getItem: (k) => get().getItem(k),
    setItem: (k, v) => get().setItem(k, v),
    removeItem: (k) => get().removeItem(k),
  };
}

interface StoredSession {
  token: string;
  expiresAt: string;
  authenticated: boolean;
}

export interface SessionInfo {
  token: string;
  authenticated: boolean;
}

export class VisitorSession {
  private current: StoredSession | null = null;
  private inflight: Promise<SessionInfo> | null = null;
  private readonly key: string;

  constructor(
    private readonly api: WebChatApi,
    private readonly storage: KeyValueStorage,
  ) {
    this.key = `ocso.webchat.${api.publicKey}.session`;
  }

  get token(): string | null {
    return this.current?.token ?? null;
  }

  get authenticated(): boolean {
    return this.current?.authenticated ?? false;
  }

  /** A usable token from an earlier visit exists (the visitor may have a conversation to resume). */
  hasStored(): boolean {
    return this.stored() !== null;
  }

  /** Create or renew the session (single-flight). */
  start(): Promise<SessionInfo> {
    this.inflight ??= this.exchange({ visitorToken: this.stored()?.token }).finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** The API answered 401: the token expired or was revoked. */
  refresh(): Promise<SessionInfo> {
    return this.start();
  }

  /** Exchange a host-site JWT (docs/archive/specs/08 §4) for an identified visitor token. */
  identify(hostToken: string): Promise<SessionInfo> {
    return this.exchange({ visitorToken: this.current?.token ?? this.stored()?.token, hostToken });
  }

  /** Forget this visitor (e.g. the host site logged the customer out) and start anonymously. */
  reset(): Promise<SessionInfo> {
    this.storage.removeItem(this.key);
    this.current = null;
    return this.exchange({});
  }

  private async exchange(body: { visitorToken?: string | undefined; hostToken?: string | undefined }): Promise<SessionInfo> {
    const res = await this.api.session(body);
    this.current = { token: res.token, expiresAt: res.expiresAt, authenticated: res.authenticated };
    try {
      this.storage.setItem(this.key, JSON.stringify(this.current));
    } catch {
      // Quota or blocked storage: the in-memory session still works for this page view.
    }
    return { token: res.token, authenticated: res.authenticated };
  }

  private stored(): StoredSession | null {
    try {
      const raw = this.storage.getItem(this.key);
      const parsed = raw ? (JSON.parse(raw) as Partial<StoredSession>) : null;
      if (!parsed || typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'string') return null;
      return Date.parse(parsed.expiresAt) > Date.now() ? { token: parsed.token, expiresAt: parsed.expiresAt, authenticated: parsed.authenticated === true } : null;
    } catch {
      return null;
    }
  }
}
