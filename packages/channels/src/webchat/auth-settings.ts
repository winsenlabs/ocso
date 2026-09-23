import { z } from 'zod';

/**
 * Web chat access settings (SPEC §C): who may open a chat session, how the
 * site's end-user tokens are verified, which context keys the site may pass
 * and which identity agent tool calls carry.
 */

/** Asymmetric algorithms accepted for JWKS-verified user tokens (never `none` or HMAC). */
export const USER_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'] as const;

const HttpsUrl = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https URL');

export const UserTokenJwks = z.object({
  verify: z.literal('jwks').meta({ title: 'Verify with' }),
  /** The identity provider's public keys (JWKS), fetched over https and cached. */
  jwksUrl: HttpsUrl.meta({ title: 'JWKS URL', description: 'https URL of your identity provider’s public keys' }),
  /** Required `iss` of every user token. */
  issuer: z.string().min(1).max(256).meta({ title: 'Issuer', description: 'required iss of every user token' }),
  /** Required `aud` (string or array member) of every user token. */
  audience: z.string().min(1).max(256).meta({ title: 'Audience', description: 'required aud of every user token' }),
  algorithms: z
    .array(z.enum(USER_TOKEN_ALGORITHMS))
    .min(1)
    .max(USER_TOKEN_ALGORITHMS.length)
    .optional()
    .meta({ title: 'Algorithms', description: 'e.g. RS256, ES256; blank = any asymmetric algorithm' }),
}).meta({ title: 'JWKS (identity provider keys)' });

export const UserTokenHs256 = z.object({
  verify: z.literal('hs256').meta({ title: 'Verify with' }),
  /** Enforced `iss` when set (defaults to the host JWT issuer setting). */
  issuer: z.string().min(1).max(256).optional().meta({ title: 'Issuer', description: 'enforced iss when set' }),
  /** Enforced `aud` when set (defaults to the host JWT audience setting). */
  audience: z.string().min(1).max(256).optional().meta({ title: 'Audience', description: 'enforced aud when set' }),
}).meta({ title: 'HS256 (host identity secret)' });

export const UserTokenVerification = z.discriminatedUnion('verify', [UserTokenJwks, UserTokenHs256]);
export type UserTokenVerification = z.infer<typeof UserTokenVerification>;

export const WebChatAuthMode = z.enum(['anonymous', 'client', 'user']);
export type WebChatAuthMode = z.infer<typeof WebChatAuthMode>;

export const WebChatAuthSettings = z.object({
  /**
   * anonymous: anyone on an allowed site may chat (today's behaviour); client: every session needs a pass
   * your backend mints with the secret key; user: every session needs a verified signed-in user.
   */
  mode: WebChatAuthMode.default('anonymous').meta({
    title: 'Auth mode',
    description: 'anonymous: anyone on an allowed site · client: a session pass from your backend · user: a verified signed-in user',
  }),
  /**
   * Accept requests that carry no Origin header (native apps, servers) in anonymous mode. Other modes always
   * accept them: the session pass or user token is the proof.
   */
  allowNativeApps: z.boolean().default(false).meta({ title: 'Allow native apps (requests without an Origin) in anonymous mode' }),
  /** How end-user tokens from your site or identity provider are verified. */
  userToken: UserTokenVerification.optional().meta({ title: 'User token verification' }),
}).meta({ title: 'Access' });
export type WebChatAuthSettings = z.infer<typeof WebChatAuthSettings>;

export const CONTEXT_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

export const WebChatContextSettings = z.object({
  /** Context keys the site may pass (the rest is dropped); at most 20. */
  allow: z
    .array(z.string().regex(CONTEXT_KEY, 'must be a letter then up to 63 letters, digits, _ . or -'))
    .max(20)
    .default([])
    .meta({ title: 'Allowed context keys', description: 'keys your site may pass (e.g. plan, orderId); others are dropped; at most 20' }),
  /** Largest accepted context, in bytes of JSON. */
  maxBytes: z.number().int().min(64).max(4_096).default(2_048).meta({ title: 'Context max bytes' }),
}).meta({ title: 'Site context' });
export type WebChatContextSettings = z.infer<typeof WebChatContextSettings>;

/** ocso: tools get OCSO-signed customer claims; passthrough: also the verified user token, to connections that opt in. */
export const WebChatToolIdentity = z.enum(['ocso', 'passthrough']).meta({
  title: 'Tool identity',
  description: 'ocso: tools get OCSO-signed customer claims · passthrough: also the verified user token, to MCP connections that opt in',
});
export type WebChatToolIdentity = z.infer<typeof WebChatToolIdentity>;

/** The channel's server-side secret key: `sk_` + 32 random bytes, base64url. */
export const SECRET_KEY_PREFIX = 'sk_';
export const SECRET_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{32,256}$/;
