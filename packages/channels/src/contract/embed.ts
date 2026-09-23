import type { ChannelRuntimeConfig } from './types.js';

/**
 * The public widget protocol of an `embeddable` kind (docs/07 §4). OCSO serves
 * the widget (`/ocso-webchat.js`, `/chat/<publicKey>`) and its API
 * (`/public/webchat/<publicKey>/*`: origins, uploads, history, SSE stream);
 * the adapter owns what is kind-specific — settings, visitor tokens and the
 * caller's identity. Errors are DomainErrors (401/403 for token problems).
 */
export interface EmbeddedChat {
  /** Customer-safe widget configuration (never secrets). */
  widgetConfig(config: ChannelRuntimeConfig): EmbedWidgetConfig;
  /** Start or continue a visitor session: anonymous, renewed, or signed in through the host site's token. */
  openSession(config: ChannelRuntimeConfig, request: EmbedSessionRequest): EmbedSession;
  /** The caller behind a bearer token (visitor token or host-site token). */
  identify(config: ChannelRuntimeConfig, bearerToken: string | undefined): EmbedVisitor;
  /** Blob-key prefix the API stores this visitor's uploads under (inbound parsing rejects other keys). */
  attachmentKeyPrefix(config: ChannelRuntimeConfig, visitor: Pick<EmbedVisitor, 'identityKind' | 'identityValue'>): string;
}

export interface EmbedWidgetConfig {
  /** Host-site origins that may embed the widget and call the public API; empty = any site. */
  allowedOrigins: readonly string[];
  /** Customer-facing look, passed through to the widget as is. */
  branding: Readonly<Record<string, unknown>>;
  maxAttachmentsPerMessage: number;
  /** Signed-in customers (host-site tokens) are enabled. */
  hostIdentity: boolean;
}

export interface EmbedSessionRequest {
  /** The visitor's previous token, to keep the same visitor (ignored when invalid or expired). */
  visitorToken?: string | undefined;
  /** A token the host site signed for a signed-in customer. */
  hostToken?: string | undefined;
}

export interface EmbedSession {
  token: string;
  visitorId: string;
  expiresAt: Date;
  /** The session belongs to a customer the host site identified. */
  authenticated: boolean;
}

/** A widget caller, in the same identity terms as inbound messages. */
export interface EmbedVisitor {
  identityKind: string;
  identityValue: string;
  alternateIdentities: ReadonlyArray<{ kind: string; value: string }>;
  profileName?: string | undefined;
  expiresAt: Date;
}

/** True when `origin` (as a browser sends it) matches an allowlist entry (`https://shop.example.com`, `https://*.example.com`). */
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
  // `*.example.com` covers `a.example.com` and `a.b.example.com`, never `example.com` itself.
  return candidate.hostname.endsWith(`.${suffixHost}`);
}
