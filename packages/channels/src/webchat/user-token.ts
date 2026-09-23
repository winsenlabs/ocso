import { createRemoteJWKSet, customFetch, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { DomainError, ErrorCategory, validation } from '@ocso/domain';
import type { ChannelFetch } from '../contract/types.js';
import { USER_TOKEN_ALGORITHMS } from './auth-settings.js';
import type { ResolvedWebChatConfig } from './config.js';
import { WebChatAuthError } from './errors.js';
import { verifyHostJwt } from './host-jwt.js';
import { CLOCK_SKEW_SECONDS, CustomerRef } from './visitor-token.js';

/**
 * End-user tokens from the embedding site (SPEC §C.1-2): verified against the
 * identity provider's JWKS (asymmetric algorithms only, issuer and audience
 * required) or, for sites that sign their own, HS256 with the channel's host
 * identity secret. Token values are never logged or put in error messages.
 */

export interface VerifiedUser {
  sub: string;
  name?: string | undefined;
  email?: string | undefined;
  expiresAt: Date;
  claims: Readonly<Record<string, unknown>>;
}

const MAX_TOKEN_LENGTH = 8_192;
const JWKS_OPTIONS = { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 } as const;
const MAX_JWKS_SETS = 200;

export class UserTokenError extends DomainError {
  constructor(code: 'user_token_required' | 'user_token_invalid', message: string) {
    super(ErrorCategory.AUTHENTICATION, code, message);
  }
}

/** Verifies user tokens; keeps one cached remote key set per JWKS URL (fetched through the host's egress fetch). */
export class UserTokenVerifier {
  private readonly keySets = new Map<string, JWTVerifyGetKey>();

  constructor(private readonly deps: { fetch: ChannelFetch; now: () => Date }) {}

  /** True when this channel can verify user tokens at all. */
  static enabled(cfg: ResolvedWebChatConfig): boolean {
    const spec = cfg.settings.auth.userToken;
    return spec ? spec.verify === 'jwks' || Boolean(cfg.hostJwtSecret) : Boolean(cfg.hostJwtSecret);
  }

  async verify(token: string, cfg: ResolvedWebChatConfig): Promise<VerifiedUser> {
    if (!UserTokenVerifier.enabled(cfg)) throw validation('host_auth_disabled', 'Authenticated customers are not enabled for this channel');
    if (token.length > MAX_TOKEN_LENGTH) throw new UserTokenError('user_token_invalid', 'The user token is too long');
    const spec = cfg.settings.auth.userToken;
    if (spec?.verify === 'jwks') return this.verifyJwks(token, spec);
    try {
      const claims = verifyHostJwt(token, cfg.hostJwtSecret!, {
        now: this.deps.now(),
        issuer: spec?.issuer ?? cfg.settings.hostJwtIssuer,
        audience: spec?.audience ?? cfg.settings.hostJwtAudience,
      });
      return { sub: claims.customerRef, name: claims.name, email: claims.email, expiresAt: claims.expiresAt, claims: claims.raw };
    } catch (error) {
      if (error instanceof WebChatAuthError) throw new UserTokenError('user_token_invalid', `The user token was not accepted (${error.reason})`);
      throw error;
    }
  }

  private async verifyJwks(token: string, spec: { jwksUrl: string; issuer: string; audience: string; algorithms?: readonly string[] | undefined }): Promise<VerifiedUser> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.keySet(spec.jwksUrl), {
        issuer: spec.issuer,
        audience: spec.audience,
        algorithms: [...(spec.algorithms ?? USER_TOKEN_ALGORITHMS)],
        requiredClaims: ['sub', 'exp'],
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: this.deps.now(),
      });
      payload = result.payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid || isFetchFailure(error)) {
        throw new DomainError(ErrorCategory.PROVIDER_UNAVAILABLE, 'user_token_keys_unavailable', 'The identity provider’s keys could not be fetched');
      }
      throw new UserTokenError('user_token_invalid', `The user token was not accepted (${reasonOf(error)})`);
    }
    const sub = CustomerRef.safeParse(payload['sub']);
    if (!sub.success) throw new UserTokenError('user_token_invalid', 'The user token subject is invalid');
    const text = (key: string, max: number) => {
      const value = payload[key];
      return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
    };
    return { sub: sub.data, name: text('name', 500), email: text('email', 320), expiresAt: new Date(Number(payload['exp']) * 1000), claims: payload };
  }

  private keySet(url: string): JWTVerifyGetKey {
    const cached = this.keySets.get(url);
    if (cached) return cached;
    if (this.keySets.size >= MAX_JWKS_SETS) this.keySets.delete(this.keySets.keys().next().value!);
    const fetchJwks = this.deps.fetch;
    const set = createRemoteJWKSet(new URL(url), {
      ...JWKS_OPTIONS,
      [customFetch]: (input: string | URL, init: RequestInit) => fetchJwks(input, init),
    });
    this.keySets.set(url, set);
    return set;
  }
}

function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && !(error instanceof joseErrors.JOSEError));
}

/** A short, value-free reason (jose codes such as ERR_JWT_EXPIRED). */
function reasonOf(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) return `claim ${error.claim}`;
  if (error instanceof joseErrors.JOSEError) return error.code.toLowerCase().replace(/^err_/, '');
  return 'invalid';
}
