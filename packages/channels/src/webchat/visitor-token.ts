import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validation } from '@ocso/domain';
import { base64UrlDecode, base64UrlEncode, equalBytes, hmacSha256 } from '../common/crypto.js';
import { WebChatAuthError } from './errors.js';

/**
 * OCSO visitor tokens: `wcv1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`,
 * signed with the channel's `visitorTokenSecret` over `wcv1.<claims>`.
 * Claims: `vid` visitor id, `cid` channel id (tokens are channel-bound),
 * optional `ref` external customer reference (set only after a host-app JWT
 * was verified), `iat`/`exp` in unix seconds. Rotating the secret revokes all.
 */

export const VISITOR_TOKEN_PREFIX = 'wcv1';
export const CLOCK_SKEW_SECONDS = 60;
/** Room for up to 4 KiB of context (base64url of JSON) besides the ids. */
export const MAX_VISITOR_TOKEN_LENGTH = 12_288;
const MAX_TOKEN_LENGTH = MAX_VISITOR_TOKEN_LENGTH;

export const VisitorId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'invalid visitor id');
export const CustomerRef = z.string().min(1).max(256);

/**
 * How the session was proven: `p` a session pass from the site's backend,
 * `u` a verified end-user token (also implies the backend or IdP vouched).
 */
export type VisitorProof = 'p' | 'u';

const TokenContext = z.object({
  s: z.enum(['h', 'c']),
  v: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  at: z.number().int().nonnegative(),
});

const Claims = z.object({
  vid: VisitorId,
  cid: z.string().min(1).max(128),
  ref: CustomerRef.optional(),
  am: z.enum(['p', 'u']).optional(),
  nm: z.string().max(500).optional(),
  cx: TokenContext.optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

/** Context carried by a visitor token: who vouched for it and the allowlisted values. */
export interface VisitorTokenContext {
  source: 'host' | 'client';
  values: Record<string, string | number | boolean>;
  at: Date;
}

export interface VisitorTokenClaims {
  visitorId: string;
  channelId: string;
  externalCustomerRef?: string | undefined;
  proof?: VisitorProof | undefined;
  name?: string | undefined;
  context?: VisitorTokenContext | undefined;
  issuedAt: Date;
  expiresAt: Date;
}

export interface IssueVisitorTokenInput {
  channelId: string;
  /** Existing visitor id to renew; a new random one is generated when absent. */
  visitorId?: string | undefined;
  /** Only after the host app authenticated the customer (see verifyHostJwt). */
  externalCustomerRef?: string | undefined;
  /** How the session was proven (client / user auth modes require it). */
  proof?: VisitorProof | undefined;
  /** Display name a verified token carried. */
  name?: string | undefined;
  context?: VisitorTokenContext | undefined;
  ttlSeconds: number;
}

export interface IssuedVisitorToken {
  token: string;
  visitorId: string;
  expiresAt: Date;
}

const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

function sign(signingInput: string, secret: string): string {
  return base64UrlEncode(hmacSha256(secret, signingInput));
}

export function newVisitorId(): string {
  return `v_${randomUUID().replace(/-/g, '')}`;
}

export function issueVisitorToken(input: IssueVisitorTokenInput, secret: string, now: Date): IssuedVisitorToken {
  const visitorId = input.visitorId ?? newVisitorId();
  const ref = input.externalCustomerRef;
  if (!VisitorId.safeParse(visitorId).success) throw validation('invalid_visitor_id', 'visitor id must be 8-128 url-safe characters');
  if (ref !== undefined && !CustomerRef.safeParse(ref).success) {
    throw validation('invalid_customer_ref', 'external customer reference must be 1-256 characters');
  }
  if (!input.channelId || input.channelId.length > 128) throw validation('invalid_channel_id', 'invalid channel id');
  const iat = seconds(now);
  const exp = iat + Math.max(1, Math.floor(input.ttlSeconds));
  const cx = input.context && Object.keys(input.context.values).length
    ? { s: input.context.source === 'host' ? ('h' as const) : ('c' as const), v: input.context.values, at: seconds(input.context.at) }
    : undefined;
  const claims = {
    vid: visitorId,
    cid: input.channelId,
    ...(ref ? { ref } : {}),
    ...(input.proof ? { am: input.proof } : {}),
    ...(input.name ? { nm: input.name.slice(0, 500) } : {}),
    ...(cx ? { cx } : {}),
    iat,
    exp,
  };
  const signingInput = `${VISITOR_TOKEN_PREFIX}.${base64UrlEncode(JSON.stringify(claims))}`;
  return { token: `${signingInput}.${sign(signingInput, secret)}`, visitorId, expiresAt: new Date(exp * 1000) };
}

export function isVisitorToken(token: string): boolean {
  return token.startsWith(`${VISITOR_TOKEN_PREFIX}.`);
}

function decodeClaims(encoded: string): z.infer<typeof Claims> {
  const bytes = base64UrlDecode(encoded);
  let json: unknown;
  try {
    json = bytes ? JSON.parse(bytes.toString('utf8')) : null;
  } catch {
    json = null;
  }
  const parsed = Claims.safeParse(json);
  if (!parsed.success) throw new WebChatAuthError('malformed', 'visitor token claims are malformed');
  return parsed.data;
}

export function verifyVisitorToken(
  token: string,
  secret: string,
  expected: { channelId: string; now: Date },
): VisitorTokenClaims {
  const segments = token.length <= MAX_TOKEN_LENGTH ? token.split('.') : [];
  const [prefix, encodedClaims, signature] = segments;
  if (segments.length !== 3 || prefix !== VISITOR_TOKEN_PREFIX || !encodedClaims || !signature) {
    throw new WebChatAuthError('malformed', 'visitor token is malformed');
  }
  const provided = base64UrlDecode(signature);
  const computed = hmacSha256(secret, `${prefix}.${encodedClaims}`);
  if (!provided || !equalBytes(provided, computed)) throw new WebChatAuthError('bad_signature', 'visitor token signature is invalid');
  const claims = decodeClaims(encodedClaims);
  const now = seconds(expected.now);
  if (claims.cid !== expected.channelId) throw new WebChatAuthError('wrong_channel', 'visitor token belongs to another channel');
  if (claims.exp + CLOCK_SKEW_SECONDS <= now) throw new WebChatAuthError('expired', 'visitor token has expired');
  if (claims.iat - CLOCK_SKEW_SECONDS > now) throw new WebChatAuthError('not_yet_valid', 'visitor token is not valid yet');
  return {
    visitorId: claims.vid,
    channelId: claims.cid,
    externalCustomerRef: claims.ref,
    proof: claims.am,
    name: claims.nm,
    context: claims.cx ? { source: claims.cx.s === 'h' ? 'host' : 'client', values: claims.cx.v, at: new Date(claims.cx.at * 1000) } : undefined,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000),
  };
}
