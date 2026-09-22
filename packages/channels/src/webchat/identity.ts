import type { RawHttpRequest } from '../contract/types.js';
import { sha256Hex } from '../common/crypto.js';
import type { ResolvedWebChatConfig } from './config.js';
import { WebChatAuthError } from './errors.js';
import { isJwtShaped, verifyHostJwt } from './host-jwt.js';
import { isVisitorToken, verifyVisitorToken } from './visitor-token.js';

/**
 * Web chat caller identity from `Authorization: Bearer <token>`:
 * - OCSO visitor token -> `webchat_visitor` (or `webchat_customer_ref` when the
 *   token carries a host-verified customer ref; the visitor id stays an alternate);
 * - host-app HS256 JWT -> `webchat_customer_ref` (`sub`), when enabled.
 */

export const WEBCHAT_IDENTITY = {
  VISITOR: 'webchat_visitor',
  CUSTOMER_REF: 'webchat_customer_ref',
} as const;

export interface WebChatIdentity {
  identityKind: string;
  identityValue: string;
  alternateIdentities: Array<{ kind: string; value: string }>;
  profileName?: string | undefined;
  expiresAt: Date;
}

export function bearerToken(headers: RawHttpRequest['headers']): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers['authorization'] ?? '');
  return match?.[1] ?? null;
}

export function identifyToken(token: string, config: ResolvedWebChatConfig, now: Date): WebChatIdentity {
  if (isVisitorToken(token)) {
    const claims = verifyVisitorToken(token, config.visitorTokenSecret, { channelId: config.channelId, now });
    const visitor = { kind: WEBCHAT_IDENTITY.VISITOR, value: claims.visitorId };
    return claims.externalCustomerRef
      ? {
          identityKind: WEBCHAT_IDENTITY.CUSTOMER_REF,
          identityValue: claims.externalCustomerRef,
          alternateIdentities: [visitor],
          expiresAt: claims.expiresAt,
        }
      : { identityKind: visitor.kind, identityValue: visitor.value, alternateIdentities: [], expiresAt: claims.expiresAt };
  }
  if (!isJwtShaped(token)) throw new WebChatAuthError('malformed', 'token is neither a visitor token nor a JWT');
  if (!config.hostJwtSecret) throw new WebChatAuthError('host_jwt_not_enabled', 'host-app tokens are not enabled for this channel');
  const claims = verifyHostJwt(token, config.hostJwtSecret, {
    now,
    issuer: config.settings.hostJwtIssuer,
    audience: config.settings.hostJwtAudience,
  });
  return {
    identityKind: WEBCHAT_IDENTITY.CUSTOMER_REF,
    identityValue: claims.customerRef,
    alternateIdentities: [],
    profileName: claims.name,
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
