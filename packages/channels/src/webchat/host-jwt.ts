import { z } from 'zod';
import { base64UrlDecode, equalBytes, hmacSha256 } from '../common/crypto.js';
import { WebChatAuthError } from './errors.js';
import { CLOCK_SKEW_SECONDS, CustomerRef } from './visitor-token.js';

/**
 * Host-app JWTs (HS256 only) for authenticated customers: the embedding
 * application signs `{ sub: <its customer id>, exp, [iat, nbf, iss, aud, name] }`
 * with the channel's `hostJwtSecret`. `alg` is pinned to HS256 — `none` and
 * asymmetric algorithms are refused (no algorithm confusion).
 */

const MAX_JWT_LENGTH = 4_096;

const Header = z.object({ alg: z.string(), typ: z.string().optional() });
const Claims = z.object({
  sub: CustomerRef,
  exp: z.number(),
  iat: z.number().optional(),
  nbf: z.number().optional(),
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  name: z.string().max(500).optional(),
});

export interface HostJwtClaims {
  customerRef: string;
  name?: string | undefined;
  expiresAt: Date;
}

export interface HostJwtExpectations {
  now: Date;
  issuer?: string | undefined;
  audience?: string | undefined;
}

function decodeJson(segment: string): unknown {
  const bytes = base64UrlDecode(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

function checkTimes(claims: z.infer<typeof Claims>, now: number): void {
  if (claims.exp + CLOCK_SKEW_SECONDS <= now) throw new WebChatAuthError('expired', 'host token has expired');
  if (claims.nbf !== undefined && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new WebChatAuthError('not_yet_valid', 'host token is not valid yet');
  }
  if (claims.iat !== undefined && claims.iat - CLOCK_SKEW_SECONDS > now) {
    throw new WebChatAuthError('not_yet_valid', 'host token was issued in the future');
  }
}

function checkIssuerAudience(claims: z.infer<typeof Claims>, expected: HostJwtExpectations): void {
  if (expected.issuer !== undefined && claims.iss !== expected.issuer) {
    throw new WebChatAuthError('wrong_issuer', 'host token issuer is not accepted');
  }
  if (expected.audience !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud];
    if (!audiences.includes(expected.audience)) throw new WebChatAuthError('wrong_audience', 'host token audience is not accepted');
  }
}

export function isJwtShaped(token: string): boolean {
  return token.split('.').length === 3;
}

export function verifyHostJwt(token: string, secret: string, expected: HostJwtExpectations): HostJwtClaims {
  const segments = token.length <= MAX_JWT_LENGTH ? token.split('.') : [];
  const [encodedHeader, encodedClaims, signature] = segments;
  if (segments.length !== 3 || !encodedHeader || !encodedClaims || !signature) {
    throw new WebChatAuthError('malformed', 'host token is malformed');
  }
  const header = Header.safeParse(decodeJson(encodedHeader));
  if (!header.success) throw new WebChatAuthError('malformed', 'host token header is malformed');
  if (header.data.alg !== 'HS256') throw new WebChatAuthError('unsupported_algorithm', 'host token must use HS256');
  const provided = base64UrlDecode(signature);
  const computed = hmacSha256(secret, `${encodedHeader}.${encodedClaims}`);
  if (!provided || !equalBytes(provided, computed)) throw new WebChatAuthError('bad_signature', 'host token signature is invalid');
  const claims = Claims.safeParse(decodeJson(encodedClaims));
  if (!claims.success) throw new WebChatAuthError('malformed', 'host token claims are malformed');
  checkTimes(claims.data, Math.floor(expected.now.getTime() / 1000));
  checkIssuerAudience(claims.data, expected);
  return {
    customerRef: claims.data.sub,
    name: claims.data.name?.trim() || undefined,
    expiresAt: new Date(claims.data.exp * 1000),
  };
}
