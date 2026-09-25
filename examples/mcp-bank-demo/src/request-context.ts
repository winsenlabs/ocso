import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-request context read from HTTP headers set by the MCP client (OCSO):
 * - `Idempotency-Key`: write tools replay the first result for a key.
 * - `X-OCSO-Customer-Claims`: short-lived JWT naming the customer the
 *   conversation is about (docs/archive/specs/08 §4). OCSO signs ES256 and publishes its
 *   JWKS; configure `claimsJwksUrl` to verify (see claims-jwks.ts). An HS256
 *   shared secret is also accepted for tests. Customer-scoped tools then refuse
 *   other customers' data. With no verifier configured the header is ignored
 *   (demo convenience — a real system must always verify).
 */
export interface CustomerClaims {
  sub: string;
  exp?: number | undefined;
}

export interface RequestContext {
  idempotencyKey: string | null;
  claims: CustomerClaims | null;
  claimsError: string | null;
}

export const EMPTY_CONTEXT: RequestContext = { idempotencyKey: null, claims: null, claimsError: null };

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function verifyClaims(token: string, secret: string, nowSeconds: number): CustomerClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h) as { alg?: unknown };
  if (header.alg !== 'HS256') throw new Error('unsupported alg');
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('bad signature');
  const payload = b64urlJson(p) as { sub?: unknown; exp?: unknown };
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('missing sub');
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds) throw new Error('expired');
  return { sub: payload.sub, ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}) };
}

/** Claims verified asynchronously (JWKS) by middleware before the MCP handler runs. */
export const verifiedClaims = new AsyncLocalStorage<{ claims: CustomerClaims | null; claimsError: string | null }>();

export function readRequestContext(req: Request | undefined, claimsSecret: string | undefined): RequestContext {
  if (!req) return EMPTY_CONTEXT;
  const key = req.headers.get('idempotency-key');
  const rawClaims = req.headers.get('x-ocso-customer-claims');
  const preVerified = verifiedClaims.getStore();
  let claims: CustomerClaims | null = preVerified?.claims ?? null;
  let claimsError: string | null = preVerified?.claimsError ?? null;
  if (!preVerified && rawClaims && claimsSecret) {
    try {
      claims = verifyClaims(rawClaims, claimsSecret, Math.floor(Date.now() / 1000));
    } catch {
      claimsError = 'Customer claims could not be verified.';
    }
  }
  return { idempotencyKey: key && key.length <= 255 ? key : null, claims, claimsError };
}

/** For customer-scoped tools: an error message when verified claims name a different customer. */
export function customerScopeError(ctx: RequestContext, cif: string): string | null {
  if (ctx.claimsError) return ctx.claimsError;
  if (ctx.claims && ctx.claims.sub !== cif) return 'The conversation is not authorised for this customer.';
  return null;
}
