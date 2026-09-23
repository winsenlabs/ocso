import type { ChannelRuntimeConfig } from './channels.js';

/**
 * The public widget protocol of an `embeddable` channel kind. OCSO serves the
 * widget and its public API (`/public/webchat/<publicKey>/*`: CORS and
 * origins, rate limits, uploads, history, SSE stream); the adapter owns what
 * is kind-specific: settings, session passes, visitor tokens, user-token
 * verification and the caller's identity. Token problems are thrown as
 * `pluginError('authentication' | 'authorization', …)`.
 */
export interface EmbeddedChat {
  /** Customer-safe widget configuration (never secrets). */
  widgetConfig(config: ChannelRuntimeConfig): EmbedWidgetConfig;
  /**
   * Start or continue a visitor session: anonymous, renewed, proven by a session pass, or signed in through a
   * user token. `hooks.consumeOnce` makes session passes single use.
   */
  openSession(config: ChannelRuntimeConfig, request: EmbedSessionRequest, hooks: EmbedSessionHooks): Promise<EmbedSession>;
  /** The caller behind a bearer token (visitor token or host-site token), under the channel's auth mode. */
  identify(config: ChannelRuntimeConfig, bearerToken: string | undefined): Promise<EmbedVisitor>;
  /** Blob-key prefix the API stores this visitor's uploads under (inbound parsing rejects other keys). */
  attachmentKeyPrefix(config: ChannelRuntimeConfig, visitor: Pick<EmbedVisitor, 'identityKind' | 'identityValue'>): string;
  /**
   * Server-to-server: the site's backend presents the channel secret key and gets a short-lived, single-use
   * session pass (optionally for a verified user, with trusted context). Absent = the kind has no passes.
   */
  mintSessionPass?(config: ChannelRuntimeConfig, request: EmbedSessionPassRequest): Promise<EmbedSessionPass>;
  /** Decrypt a held user token (see `EmbedHeldUserToken`); null when it can no longer be opened. */
  openUserToken?(config: ChannelRuntimeConfig, sealed: string): string | null;
}

export type EmbedAuthMode = 'anonymous' | 'client' | 'user';

export interface EmbedWidgetConfig {
  /** Host-site origins that may embed the widget and call the public API; empty = any site. */
  allowedOrigins: readonly string[];
  /** Customer-facing look, passed through to the widget as is. */
  branding: Readonly<Record<string, unknown>>;
  maxAttachmentsPerMessage: number;
  /** Signed-in customers (host-site tokens) are enabled. */
  hostIdentity: boolean;
  /** Who may open sessions: anyone (anonymous), holders of a session pass (client), or verified users (user). */
  authMode: EmbedAuthMode;
  /** Requests without an Origin header (native apps, servers) are accepted in anonymous mode too. */
  allowNativeApps: boolean;
}

export type EmbedContextValues = Readonly<Record<string, string | number | boolean>>;

/** Allowlisted key/values the site passed: `host` = vouched by its backend or a verified token, `client` = from the browser. */
export interface EmbedContext {
  source: 'host' | 'client';
  values: EmbedContextValues;
  at: Date;
}

export interface EmbedSessionRequest {
  /** The visitor's previous token, to keep the same visitor (ignored when invalid or expired). */
  visitorToken?: string | undefined;
  /** A token the host site signed for a signed-in customer (legacy name of `userToken`). */
  hostToken?: string | undefined;
  /** A session pass the site's backend minted (auth modes client and user). */
  sessionPass?: string | undefined;
  /** An end-user token from the site or its identity provider, verified here. */
  userToken?: string | undefined;
  /** Context sent by the client itself; kept as unverified (`client`) and allowlisted. */
  context?: EmbedContextValues | undefined;
}

export interface EmbedSessionHooks {
  /** Record a single-use id until `expiresAt`; false when it was already used. */
  consumeOnce(id: string, expiresAt: Date): Promise<boolean>;
}

/** A verified end-user token to keep for tool calls (tool identity passthrough), sealed by the kind. Never logged. */
export interface EmbedHeldUserToken {
  sealed: string;
  expiresAt: Date;
}

export interface EmbedSession {
  token: string;
  visitorId: string;
  expiresAt: Date;
  /** The session belongs to a customer the host site identified. */
  authenticated: boolean;
  /** Who the issued token identifies (same terms as inbound messages). */
  visitor: EmbedVisitor;
  /** A user token to hold for this visitor's tool calls; absent unless the channel passes user tokens through. */
  userToken?: EmbedHeldUserToken | undefined;
}

export interface EmbedSessionPassRequest {
  /** The bearer credential the backend presented (compared in constant time with the channel secret key). */
  secretKey: string | undefined;
  userToken?: string | undefined;
  /** Trusted context from the backend (allowlisted and size-limited). */
  context?: EmbedContextValues | undefined;
  visitorId?: string | undefined;
  ttlSeconds?: number | undefined;
}

export interface EmbedSessionPass {
  sessionPass: string;
  expiresAt: Date;
  /** Set when a user token was verified and the channel passes user tokens through: hold it for this customer. */
  userToken?: (EmbedHeldUserToken & { visitor: Pick<EmbedVisitor, 'identityKind' | 'identityValue' | 'alternateIdentities' | 'profileName'> }) | undefined;
}

/** A widget caller, in the same identity terms as inbound messages. */
export interface EmbedVisitor {
  identityKind: string;
  identityValue: string;
  alternateIdentities: ReadonlyArray<{ kind: string; value: string }>;
  profileName?: string | undefined;
  /** The primary identity was vouched for by the site. */
  verified?: boolean | undefined;
  /** Context the visitor's session carries. */
  context?: EmbedContext | undefined;
  expiresAt: Date;
}

/**
 * True when `origin` (as a browser sends it) matches an allowlist entry:
 * exact origins (`https://shop.example.com`) or one wildcard label
 * (`https://*.example.com`, which covers subdomains but never `example.com`).
 */
export function originAllowed(origin: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === 'null' || parsed.origin !== origin.toLowerCase()) return false;
  return allowlist.some((entry) => matches(parsed, entry));
}

function matches(candidate: URL, entry: string): boolean {
  const wildcard = entry.includes('://*.');
  if (!wildcard) return candidate.origin === entry;
  const [scheme, rest = ''] = entry.split('://*.');
  const [suffixHost = '', port = ''] = rest.split(':');
  if (`${candidate.protocol}` !== `${scheme}:`) return false;
  if (candidate.port !== port) return false;
  return candidate.hostname.endsWith(`.${suffixHost}`);
}
