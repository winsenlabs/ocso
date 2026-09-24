import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { ChannelRuntimeConfig, OutboundTarget, RawHttpRequest } from '../../src/index.js';

export const APP_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
export const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
export const OTHER_TENANT = '11111111-2222-4333-8444-555555555555';
export const USER_AAD = '29f4a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
export const BYSTANDER_AAD = '3a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
export const APP_PASSWORD = 'Qx~8Q~teams.client.secret-value_0001';
export const BOT_ID = `28:${APP_ID}`;
export const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
export const PERSONAL_CONVERSATION = 'a:1Xk9-personal-conversation-id';
export const CHANNEL_CONVERSATION = '19:abc123def456@thread.tacv2;messageid=1790244000123';
export const METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
export const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
export const ISSUER = 'https://api.botframework.com';
export const NOW = new Date('2026-09-24T10:00:00Z');
export const PUBLIC_KEY = 'mt2w3e4r5t6y7u8i9o0p1a2s';
export const WEBHOOK_URL = `https://ocso.example.com/channels/ms-teams/${PUBLIC_KEY}/webhook`;

export function mtConfig(settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}, webhookUrl: string | null = WEBHOOK_URL): ChannelRuntimeConfig {
  return {
    id: 'chn_teams_main',
    kind: 'MS_TEAMS',
    name: 'Meridian Teams',
    settings: { appId: APP_ID, tenantId: TENANT, ...settings },
    secrets: { appPassword: APP_PASSWORD, ...secrets },
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

export interface SigningKeyPair {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

export async function signingKey(kid = 'bf-key-1', endorsements: string[] | null = ['msteams']): Promise<SigningKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, use: 'sig', ...(endorsements ? { endorsements } : {}) };
  return { kid, privateKey, jwk };
}

/** A Bot Connector → bot token as Microsoft issues it (defaults: valid now for APP_ID, serviceurl = SERVICE_URL). */
export async function connectorToken(
  key: SigningKeyPair,
  options: { aud?: string; iss?: string; serviceUrl?: string | null; iat?: number; exp?: number; kid?: string; alg?: string } = {},
): Promise<string> {
  const iat = options.iat ?? Math.floor(NOW.getTime() / 1000) - 60;
  const claims: Record<string, unknown> = {};
  if (options.serviceUrl !== null) claims['serviceurl'] = options.serviceUrl ?? SERVICE_URL;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: options.kid ?? key.kid, typ: 'JWT' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? APP_ID)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(options.exp ?? iat + 3600)
    .sign(key.privateKey);
}

export function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id: '1790244000456',
    timestamp: '2026-09-24T10:00:00.000Z',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:1user-teams-id', name: 'Asha Rao', aadObjectId: USER_AAD },
    recipient: { id: BOT_ID, name: 'OCSO Assistant' },
    conversation: { id: PERSONAL_CONVERSATION, conversationType: 'personal', tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text: 'Where is my card?',
    textFormat: 'plain',
    locale: 'en-US',
    ...overrides,
  };
}

export const mentionActivity = (overrides: Record<string, unknown> = {}) =>
  activity({
    id: '1790244000789',
    conversation: { id: CHANNEL_CONVERSATION, conversationType: 'channel', tenantId: TENANT, isGroup: true },
    text: '<at>OCSO Assistant</at> can you help with &lt;refunds&gt;?',
    textFormat: 'xml',
    entities: [{ type: 'mention', text: '<at>OCSO Assistant</at>', mentioned: { id: BOT_ID, name: 'OCSO Assistant' } }],
    ...overrides,
  });

export function teamsRequest(body: unknown, token: string | null, method: 'GET' | 'POST' = 'POST'): RawHttpRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return { method, url: WEBHOOK_URL, headers, query: {}, rawBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') };
}

export function teamsTarget(overrides: Partial<OutboundTarget> = {}): OutboundTarget {
  return {
    identityKind: 'teams_user',
    identityValue: `${TENANT}:${USER_AAD}`,
    lastInboundAt: NOW,
    replyContext: { serviceUrl: SERVICE_URL, conversationId: PERSONAL_CONVERSATION, conversationType: 'personal', tenantId: TENANT, botId: BOT_ID },
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect: RequestInit['redirect'];
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export type Responder = (call: RecordedCall, n: number) => Response | Promise<Response> | undefined;

/**
 * A fake Microsoft: OpenID metadata, JWKS, Entra token endpoint and the Bot Connector. `connector` answers
 * connector posts (default 201 with an id); `token` the token endpoint (default a one-hour token).
 */
export function microsoftFetch(options: { keys?: JWK[]; token?: Responder; connector?: Responder; metadata?: Responder } = {}) {
  const calls: RecordedCall[] = [];
  let tokens = 0;
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? String(init.body) : '', redirect: init?.redirect };
    calls.push(call);
    const n = calls.length;
    if (call.url === METADATA_URL) return (await options.metadata?.(call, n)) ?? json({ issuer: ISSUER, jwks_uri: JWKS_URL, id_token_signing_alg_values_supported: ['RS256'] });
    if (call.url === JWKS_URL) return json({ keys: options.keys ?? [] });
    if (call.url.includes('/oauth2/v2.0/token')) {
      tokens += 1;
      return (await options.token?.(call, n)) ?? json({ token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: `bot-connector-token-${tokens}` });
    }
    return (await options.connector?.(call, n)) ?? json({ id: `1790244100${String(n).padStart(3, '0')}` }, 201);
  };
  return { fetch, calls, connectorCalls: () => calls.filter((c) => c.url.includes('/v3/conversations/')), tokenCalls: () => calls.filter((c) => c.url.includes('/oauth2/v2.0/token')) };
}
