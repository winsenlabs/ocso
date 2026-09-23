import type { RawHttpRequest, VerificationResult } from '../contract/types.js';
import { equalBytes, equalSecrets, hmacSha256 } from '../common/crypto.js';

/**
 * Webhook authenticity (PM/research/02 §5):
 * - GET: Meta's subscription handshake — `hub.verify_token` must match the
 *   channel's verify token (constant time); the challenge is echoed back.
 * - POST: `X-Hub-Signature-256: sha256=<hex>` is HMAC-SHA256 of the RAW body
 *   with the App Secret, checked before any JSON parsing.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
/** Meta sends a numeric challenge; anything else is refused rather than reflected. */
const SAFE_CHALLENGE = /^[A-Za-z0-9._-]{1,256}$/;

export interface WhatsAppVerificationSecrets {
  appSecret?: string | undefined;
  verifyToken?: string | undefined;
}

const rejected = (status: 400 | 401 | 403, reason: string): VerificationResult => ({ kind: 'rejected', status, reason });

export function verifySubscriptionChallenge(
  query: RawHttpRequest['query'],
  verifyToken: string | undefined,
): VerificationResult {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || challenge === undefined) return rejected(400, 'not a webhook subscription request');
  if (!verifyToken) return rejected(403, 'verify token not configured');
  if (!token || !equalSecrets(token, verifyToken)) return rejected(403, 'verify token mismatch');
  if (!SAFE_CHALLENGE.test(challenge)) return rejected(400, 'invalid challenge');
  return { kind: 'challenge', status: 200, body: challenge };
}

export function verifyWebhookSignature(
  headers: RawHttpRequest['headers'],
  rawBody: Buffer | null,
  appSecret: string | undefined,
): VerificationResult {
  if (!appSecret) return rejected(403, 'app secret not configured');
  const header = headers[SIGNATURE_HEADER];
  if (!header) return rejected(401, 'missing X-Hub-Signature-256 header');
  const match = SIGNATURE.exec(header.trim());
  if (!match?.[1]) return rejected(401, 'malformed X-Hub-Signature-256 header');
  if (rawBody === null) return rejected(400, 'missing request body');
  const expected = hmacSha256(appSecret, rawBody);
  const provided = Buffer.from(match[1], 'hex');
  return equalBytes(provided, expected) ? { kind: 'verified' } : rejected(403, 'signature mismatch');
}

export function verifyWhatsAppRequest(req: RawHttpRequest, secrets: WhatsAppVerificationSecrets): VerificationResult {
  return req.method === 'GET'
    ? verifySubscriptionChallenge(req.query, secrets.verifyToken)
    : verifyWebhookSignature(req.headers, req.rawBody, secrets.appSecret);
}
