import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { McpCredentialError } from '../errors.js';
import type { McpOAuthClientInformation, McpOAuthTokens, StoredOAuthTokenState } from '../types.js';

/**
 * Serialization of OAuth secrets exactly as `tokenRef` / `clientInfoRef`
 * must resolve to them through the CredentialPort. OCSO-owned shapes, so
 * persisted data does not depend on SDK types (build rule §12).
 */

const TokenStateSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1),
  tokenType: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().positive().optional(),
  scope: z.string().optional(),
  issuer: z.string().min(1),
  resource: z.string().optional(),
});

const ClientInfoSchema = z.object({
  v: z.literal(1),
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  clientSecretExpiresAt: z.number().int().nonnegative().optional(),
  registration: z.enum(['CLIENT_ID_METADATA_DOCUMENT', 'PRE_REGISTERED', 'EXISTING', 'DYNAMIC']),
});

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function serializeOAuthTokenState(state: StoredOAuthTokenState): string {
  return JSON.stringify(stripUndefined({ v: 1, ...state }));
}

export function parseOAuthTokenState(raw: string): StoredOAuthTokenState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new McpCredentialError('malformed');
  }
  const parsed = TokenStateSchema.safeParse(json);
  if (!parsed.success) throw new McpCredentialError('malformed');
  const { v: _v, ...state } = parsed.data;
  return state;
}

export function serializeClientInformation(info: McpOAuthClientInformation): string {
  return JSON.stringify(stripUndefined({ v: 1, ...info }));
}

export function parseClientInformation(raw: string): McpOAuthClientInformation {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new McpCredentialError('malformed');
  }
  const parsed = ClientInfoSchema.safeParse(json);
  if (!parsed.success) throw new McpCredentialError('malformed');
  const { v: _v, ...info } = parsed.data;
  return info;
}

/** SDK token response → OCSO token set (relative `expires_in` becomes absolute `expiresAt`). */
export function tokensFromSdk(tokens: OAuthTokens, now: number = Date.now()): McpOAuthTokens {
  return stripUndefined({
    accessToken: tokens.access_token,
    tokenType: tokens.token_type,
    refreshToken: tokens.refresh_token,
    expiresAt: typeof tokens.expires_in === 'number' ? now + tokens.expires_in * 1000 : undefined,
    scope: tokens.scope,
  });
}

export function toSdkClientInformation(info: Pick<McpOAuthClientInformation, 'clientId' | 'clientSecret' | 'clientSecretExpiresAt'>): OAuthClientInformationMixed {
  return stripUndefined({
    client_id: info.clientId,
    client_secret: info.clientSecret,
    client_secret_expires_at: info.clientSecretExpiresAt,
  }) as OAuthClientInformationMixed;
}

/** True when the access token is expired or expires within `skewMs`. Unknown expiry counts as valid. */
export function isExpiring(tokens: McpOAuthTokens, now: number = Date.now(), skewMs = 60_000): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - skewMs <= now;
}
