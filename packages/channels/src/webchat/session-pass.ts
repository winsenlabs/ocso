import { hkdfSync, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ErrorCategory } from '@ocso/domain';
import { base64UrlDecode, base64UrlEncode, equalBytes, equalSecrets, hmacSha256 } from '../common/crypto.js';
import { CLOCK_SKEW_SECONDS, CustomerRef, VisitorId } from './visitor-token.js';
import { ContextValues } from './context.js';

/**
 * Session passes (SPEC §C.1): `wsp1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`,
 * minted server-to-server by the site's backend (it holds the channel's
 * secret key) and exchanged once by the browser or app for a visitor token.
 * The HMAC key is derived from the secret key (HKDF-SHA256, info
 * `ocso-webchat-session-pass`), so the pass never reveals the key itself.
 * Claims: `ch` channel id, `v` visitor id, `sub`/`name` of a verified user,
 * `ctx` trusted context, `ut: 1` when a user token was verified, `iat`/`exp`/`jti`.
 */

export const SESSION_PASS_PREFIX = 'wsp1';
const MAX_PASS_LENGTH = 16_384;
export const PASS_TTL = { min: 60, max: 3_600, default: 600 } as const;

const Claims = z.object({
  ch: z.string().min(1).max(128),
  v: VisitorId.optional(),
  sub: CustomerRef.optional(),
  name: z.string().max(500).optional(),
  ctx: ContextValues.optional(),
  ut: z.literal(1).optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(8).max(64),
});
export type SessionPassClaims = z.infer<typeof Claims>;

export type SessionPassFailure = 'session_pass_required' | 'session_pass_invalid' | 'session_pass_expired' | 'session_pass_used' | 'secret_key_invalid';

/** 401s the client answers by fetching a fresh pass (codes are part of the public API). */
export class SessionPassError extends DomainError {
  constructor(code: SessionPassFailure, message: string) {
    super(ErrorCategory.AUTHENTICATION, code, message);
  }
}

/** Purpose-bound key material derived from the channel secret key (never the key itself). */
export function deriveKey(secretKey: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

const passKey = (secretKey: string) => deriveKey(secretKey, 'ocso-webchat-session-pass').toString('base64');

/** Constant-time check of the `Authorization: Bearer <secret key>` a backend presented. */
export function assertSecretKey(presented: string | undefined, secretKey: string | undefined): void {
  if (!secretKey) throw new SessionPassError('secret_key_invalid', 'This channel has no secret key; rotate one in the channel settings');
  if (!presented || !equalSecrets(presented, secretKey)) throw new SessionPassError('secret_key_invalid', 'The secret key is not valid for this channel');
}

export interface MintSessionPassInput {
  channelId: string;
  ttlSeconds: number;
  visitorId?: string | undefined;
  sub?: string | undefined;
  name?: string | undefined;
  context?: Readonly<Record<string, string | number | boolean>> | undefined;
  userVerified: boolean;
}

export function mintSessionPass(input: MintSessionPassInput, secretKey: string, now: Date): { pass: string; claims: SessionPassClaims; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const ttl = Math.min(PASS_TTL.max, Math.max(PASS_TTL.min, Math.floor(input.ttlSeconds)));
  const claims: SessionPassClaims = {
    ch: input.channelId,
    ...(input.visitorId ? { v: input.visitorId } : {}),
    ...(input.sub ? { sub: input.sub } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.context && Object.keys(input.context).length ? { ctx: { ...input.context } } : {}),
    ...(input.userVerified ? { ut: 1 as const } : {}),
    iat,
    exp: iat + ttl,
    jti: randomUUID().replace(/-/g, ''),
  };
  const signingInput = `${SESSION_PASS_PREFIX}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = base64UrlEncode(hmacSha256(passKey(secretKey), signingInput));
  return { pass: `${signingInput}.${signature}`, claims, expiresAt: new Date(claims.exp * 1000) };
}

/** Signature, channel and time checks; single use is the caller's (it needs storage). */
export function verifySessionPass(pass: string, secretKey: string | undefined, expected: { channelId: string; now: Date }): SessionPassClaims {
  if (!secretKey) throw new SessionPassError('session_pass_invalid', 'This channel cannot accept session passes (no secret key)');
  const segments = pass.length <= MAX_PASS_LENGTH ? pass.split('.') : [];
  const [prefix, encoded, signature] = segments;
  if (segments.length !== 3 || prefix !== SESSION_PASS_PREFIX || !encoded || !signature) {
    throw new SessionPassError('session_pass_invalid', 'The session pass is malformed');
  }
  const provided = base64UrlDecode(signature);
  const computed = hmacSha256(passKey(secretKey), `${prefix}.${encoded}`);
  if (!provided || !equalBytes(provided, computed)) throw new SessionPassError('session_pass_invalid', 'The session pass signature is invalid');
  let json: unknown = null;
  try {
    json = JSON.parse(base64UrlDecode(encoded)?.toString('utf8') ?? 'null');
  } catch {
    json = null;
  }
  const claims = Claims.safeParse(json);
  if (!claims.success) throw new SessionPassError('session_pass_invalid', 'The session pass claims are malformed');
  if (claims.data.ch !== expected.channelId) throw new SessionPassError('session_pass_invalid', 'The session pass belongs to another channel');
  const now = Math.floor(expected.now.getTime() / 1000);
  if (claims.data.exp <= now) throw new SessionPassError('session_pass_expired', 'The session pass has expired');
  if (claims.data.iat - CLOCK_SKEW_SECONDS > now) throw new SessionPassError('session_pass_invalid', 'The session pass was issued in the future');
  return claims.data;
}
