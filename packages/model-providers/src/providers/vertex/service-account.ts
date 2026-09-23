import { createSign } from 'node:crypto';
import { DomainError, ErrorCategory, validation } from '@ocso/domain';
import { z } from 'zod';

/**
 * Google service-account OAuth (JWT bearer grant, RFC 7523) owned by OCSO so
 * the token exchange goes through the injected `fetch` (contract-testable,
 * proxy-friendly) and failures are normalized. Tokens are cached until one
 * minute before expiry, with a single in-flight refresh.
 */

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const REFRESH_MARGIN_MS = 60_000;

const keySchema = z.object({
  type: z.literal('service_account').optional(),
  client_email: z.string().min(3),
  private_key: z.string().includes('PRIVATE KEY'),
  private_key_id: z.string().optional(),
  project_id: z.string().optional(),
  token_uri: z.url({ protocol: /^https$/ }).optional(),
});

export type ServiceAccountKey = z.infer<typeof keySchema>;

/** Parse the key JSON. Errors name fields only, never values. */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw validation('provider_credentials_invalid', 'The Google service account key is not valid JSON', {
      fields: ['serviceAccountJson'],
    });
  }
  const parsed = keySchema.safeParse(raw);
  if (!parsed.success) {
    throw validation('provider_credentials_invalid', 'The Google service account key is incomplete', {
      fields: parsed.error.issues.map((i) => `serviceAccountJson.${i.path.join('.')}`),
    });
  }
  return parsed.data;
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

export function signServiceAccountJwt(key: ServiceAccountKey, nowSeconds: number): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(input).sign(key.private_key);
  return `${input}.${b64url(signature)}`;
}

const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().optional() });

function authFailure(status?: number): DomainError {
  const category = status === undefined || status >= 500 ? ErrorCategory.PROVIDER_UNAVAILABLE : ErrorCategory.AUTHENTICATION;
  return new DomainError(
    category,
    category === ErrorCategory.AUTHENTICATION ? 'provider_authentication_failed' : 'provider_unavailable',
    `Google service account token exchange failed${status ? ` (HTTP ${status})` : ''} [VERTEX]`,
    status ? { statusCode: status } : {},
  );
}

export function createServiceAccountTokenProvider(
  key: ServiceAccountKey,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    const assertion = signServiceAccountJwt(key, Math.floor(now() / 1000));
    let response: Response;
    try {
      response = await fetchImpl(key.token_uri ?? DEFAULT_TOKEN_URI, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
    } catch {
      throw authFailure();
    }
    if (!response.ok) throw authFailure(response.status);
    const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw authFailure(response.status);
    cached = { token: parsed.data.access_token, expiresAt: now() + (parsed.data.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return async () => {
    if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    inflight ??= exchange().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}

/**
 * Application Default Credentials token source (APPLICATION_DEFAULT mode),
 * for calls OCSO makes itself (the model listing). google-auth-library is
 * imported lazily and caches/refreshes tokens; failures become a safe
 * AUTHENTICATION error.
 */
export function createAdcTokenProvider(): () => Promise<string> {
  let auth: Promise<{ getAccessToken(): Promise<string | null | undefined> }> | undefined;
  return async () => {
    try {
      auth ??= import('google-auth-library').then((m) => new m.GoogleAuth({ scopes: [SCOPE] }));
      const token = await (await auth).getAccessToken();
      if (token) return token;
    } catch {
      // fall through to the safe error below
    }
    throw new DomainError(ErrorCategory.AUTHENTICATION, 'provider_credentials_unavailable', 'Google Application Default Credentials could not be obtained [VERTEX]');
  };
}
