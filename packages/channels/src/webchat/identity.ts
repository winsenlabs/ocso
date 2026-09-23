import type { RawHttpRequest } from '../contract/types.js';
import { sha256Hex } from '../common/crypto.js';
import type { ResolvedWebChatConfig } from './config.js';
import { WebChatAuthError } from './errors.js';
import { isJwtShaped, verifyHostJwt } from './host-jwt.js';
import { isVisitorToken, verifyVisitorToken, type VisitorTokenClaims, type VisitorTokenContext } from './visitor-token.js';

/**
 * Web chat caller identity from `Authorization: Bearer <token>`:
 * - OCSO visitor token -> `webchat_visitor` (or `webchat_customer_ref` when the
 *   token carries a host-verified customer ref; the visitor id stays an alternate);
 * - host-app HS256 JWT -> `webchat_customer_ref` (`sub`), when enabled.
 * A verified user id is stored as `<channel id>:<sub>` (see `customerRefValue`): each channel vouches only
 * for its own users, so two channels whose sites issue the same `sub` never share a customer.
 */

export const WEBCHAT_IDENTITY = {
  VISITOR: 'webchat_visitor',
  CUSTOMER_REF: 'webchat_customer_ref',
} as const;

/** The `webchat_customer_ref` identity value for a user the channel verified: namespaced by the channel id. */
export function customerRefValue(channelId: string, sub: string): string {
  return `${channelId}:${sub}`;
}

export interface WebChatIdentity {
  identityKind: string;
  identityValue: string;
  alternateIdentities: Array<{ kind: string; value: string }>;
  profileName?: string | undefined;
  /** The primary identity was vouched for by the site (verified user token or its backend's session pass). */
  verified?: boolean | undefined;
  /** Context the latest session carried (allowlisted, labelled by who vouched for it). */
  context?: VisitorTokenContext | undefined;
  expiresAt: Date;
}

export function bearerToken(headers: RawHttpRequest['headers']): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers['authorization'] ?? '');
  return match?.[1] ?? null;
}

/** The auth mode's rule for a visitor token: client needs a session-pass proof, user a verified user. */
function assertModeAllows(claims: VisitorTokenClaims, config: ResolvedWebChatConfig): void {
  const { mode } = config.settings.auth;
  if (mode === 'client' && !claims.proof) throw new WebChatAuthError('session_pass_required', 'this chat needs a session pass from the site');
  if (mode === 'user' && !claims.externalCustomerRef) throw new WebChatAuthError('user_required', 'this chat needs a signed-in user');
}

export function identifyToken(token: string, config: ResolvedWebChatConfig, now: Date): WebChatIdentity {
  if (isVisitorToken(token)) {
    const claims = verifyVisitorToken(token, config.visitorTokenSecret, { channelId: config.channelId, now });
    assertModeAllows(claims, config);
    const visitor = { kind: WEBCHAT_IDENTITY.VISITOR, value: claims.visitorId };
    const common = { expiresAt: claims.expiresAt, profileName: claims.name, context: claims.context };
    return claims.externalCustomerRef
      ? { ...common, identityKind: WEBCHAT_IDENTITY.CUSTOMER_REF, identityValue: customerRefValue(config.channelId, claims.externalCustomerRef), alternateIdentities: [visitor], verified: true }
      : { ...common, identityKind: visitor.kind, identityValue: visitor.value, alternateIdentities: [] };
  }
  if (!isJwtShaped(token)) throw new WebChatAuthError('malformed', 'token is neither a visitor token nor a JWT');
  // A site-signed HS256 token is accepted directly as the bearer; JWKS-verified user tokens are exchanged at /session.
  // Client mode needs a session pass for every session (SPEC C.2), so there the token must go through /session with one.
  if (config.settings.auth.mode === 'client') throw new WebChatAuthError('session_pass_required', 'this chat needs a session pass from the site');
  const spec = config.settings.auth.userToken;
  if (!config.hostJwtSecret || spec?.verify === 'jwks') throw new WebChatAuthError('host_jwt_not_enabled', 'host-app tokens are not enabled for this channel');
  const claims = verifyHostJwt(token, config.hostJwtSecret, {
    now,
    issuer: spec?.issuer ?? config.settings.hostJwtIssuer,
    audience: spec?.audience ?? config.settings.hostJwtAudience,
  });
  return {
    identityKind: WEBCHAT_IDENTITY.CUSTOMER_REF,
    identityValue: customerRefValue(config.channelId, claims.customerRef),
    alternateIdentities: [],
    profileName: claims.name,
    verified: true,
    expiresAt: claims.expiresAt,
  };
}

export function identifyRequest(req: RawHttpRequest, config: ResolvedWebChatConfig, now: Date): WebChatIdentity {
  const token = bearerToken(req.headers);
  if (!token) throw new WebChatAuthError('missing', 'missing bearer token');
  return identifyToken(token, config, now);
}

/** Stable, non-reversible namespace for one identity (idempotency keys, blob prefixes). */
export function identityDigest(identity: Pick<WebChatIdentity, 'identityKind' | 'identityValue'>): string {
  return sha256Hex(`${identity.identityKind}:${identity.identityValue}`).slice(0, 32);
}
