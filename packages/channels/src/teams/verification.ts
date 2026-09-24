import { errors as joseErrors, jwtVerify, type JWTHeaderParameters, type JWTPayload } from 'jose';
import type { ChannelRuntimeConfig, RawHttpRequest, VerificationResult } from '../contract/types.js';
import { resolveTeamsSettings } from './config.js';
import { allowedServiceUrl } from './service-url.js';
import { readActivityEnvelope } from './activity.js';
import { SigningKeysUnavailableError, type BotFrameworkKeyStore } from './signing-keys.js';

/**
 * Bot Connector → bot authentication (Microsoft: "Authenticate requests from
 * the Bot Connector service"): the `Authorization: Bearer` JWT must be RS256,
 * signed by a key from the Bot Framework OpenID metadata (endorsed for the
 * activity's channel when the key lists endorsements), issued by
 * `https://api.botframework.com` (the channel's cloud), for audience = the
 * bot's Microsoft App ID, within its validity (5 minutes clock skew), and its
 * `serviceurl` claim must equal the activity's `serviceUrl`. OCSO further
 * requires that service URL to be a Bot Connector host (it later sends a
 * bearer token there). Missing or expired credentials are 401; anything forged
 * or meant for another bot is 403. Unreachable signing keys throw (502) so the
 * Bot Connector retries.
 */

export const CLOCK_SKEW_SECONDS = 300;
const MAX_TOKEN_LENGTH = 8_192;

const reject = (status: 400 | 401 | 403, reason: string): VerificationResult => ({ kind: 'rejected', status, reason });

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)\s*$/i.exec(header ?? '');
  return match?.[1] && match[1].length <= MAX_TOKEN_LENGTH ? match[1] : null;
}

function claimString(payload: JWTPayload, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

const sameServiceUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

export async function verifyTeamsRequest(req: RawHttpRequest, config: ChannelRuntimeConfig, deps: { keys: BotFrameworkKeyStore; now: () => Date }): Promise<VerificationResult> {
  if (req.method !== 'POST') return reject(400, 'the Bot Connector only POSTs activities');
  const resolved = resolveTeamsSettings(config);
  if (!resolved) return reject(403, 'channel is not configured');
  const { settings, endpoints } = resolved;

  const token = bearerToken(req.headers['authorization']);
  if (!token) return reject(401, 'missing bearer token');
  const activity = readActivityEnvelope(req.rawBody);
  if (!activity) return reject(400, 'body is not a Bot Framework activity');

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(
      token,
      async (header: JWTHeaderParameters) => {
        if (header.alg !== 'RS256' || !header.kid) throw new joseErrors.JWSInvalid('unsupported token header');
        const key = await deps.keys.key(endpoints.openIdMetadataUrl, header.kid);
        if (!key) throw new joseErrors.JWKSNoMatchingKey();
        // A key that lists endorsements may only sign tokens for those channels (e.g. `msteams`).
        if (key.endorsements.length && !key.endorsements.includes(activity.channelId)) throw new joseErrors.JWKSNoMatchingKey('key not endorsed for this channel');
        return key.key;
      },
      {
        algorithms: ['RS256'],
        issuer: endpoints.issuer,
        audience: settings.appId,
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: deps.now(),
        requiredClaims: ['exp'],
      },
    );
    payload = verified.payload;
  } catch (error) {
    if (error instanceof SigningKeysUnavailableError) throw error;
    if (error instanceof joseErrors.JWTExpired) return reject(401, 'token expired');
    if (error instanceof joseErrors.JWTClaimValidationFailed) return reject(403, `token ${error.claim} claim is not valid for this bot`);
    if (error instanceof joseErrors.JWKSNoMatchingKey) return reject(403, 'token signed by an unknown key');
    return reject(403, 'token signature invalid');
  }

  const claimed = claimString(payload, 'serviceurl', 'serviceUrl');
  if (!claimed || !sameServiceUrl(claimed, activity.serviceUrl)) return reject(403, 'serviceUrl does not match the token');
  if (!allowedServiceUrl(activity.serviceUrl, endpoints.serviceUrlHosts)) return reject(403, 'serviceUrl is not a Bot Connector endpoint');
  return { kind: 'verified' };
}
