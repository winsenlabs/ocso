import type { RawHttpRequest, VerificationResult } from '../contract/types.js';
import { equalBytes, hmacSha256 } from '../common/crypto.js';

/**
 * Slack request signing (api.slack.com/authentication/verifying-requests-from-slack):
 * `X-Slack-Signature: v0=<hex>` is HMAC-SHA256(signing secret, `v0:{X-Slack-Request-Timestamp}:{raw body}`).
 * Requests older or newer than five minutes are refused (replay window). The
 * comparison is constant time; the body is never parsed before this passes.
 */

const SIGNATURE_HEADER = 'x-slack-signature';
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const SIGNATURE = /^v0=([0-9a-f]{64})$/i;
const TIMESTAMP = /^\d{1,12}$/;
/** Slack's recommended replay window. */
export const SLACK_SIGNATURE_WINDOW_SECONDS = 300;

const rejected = (status: 400 | 401 | 403, reason: string): VerificationResult => ({ kind: 'rejected', status, reason });

/** `v0=<hex>` for a body at a timestamp (seconds), as Slack computes it. */
export function slackSignature(signingSecret: string, timestamp: string, rawBody: Buffer | string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const base = Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), body]);
  return `v0=${hmacSha256(signingSecret, base).toString('hex')}`;
}

export function verifySlackSignature(req: RawHttpRequest, signingSecret: string | undefined, now: Date): VerificationResult {
  if (req.method !== 'POST') return rejected(400, 'Slack only POSTs to this webhook');
  if (!signingSecret?.trim()) return rejected(403, 'signing secret not configured');
  const header = req.headers[SIGNATURE_HEADER]?.trim();
  const timestamp = req.headers[TIMESTAMP_HEADER]?.trim();
  if (!header || !timestamp) return rejected(401, 'missing X-Slack-Signature or X-Slack-Request-Timestamp header');
  const match = SIGNATURE.exec(header);
  if (!match?.[1]) return rejected(401, 'malformed X-Slack-Signature header');
  if (!TIMESTAMP.test(timestamp)) return rejected(401, 'malformed X-Slack-Request-Timestamp header');
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > SLACK_SIGNATURE_WINDOW_SECONDS) return rejected(401, 'request timestamp outside the five-minute window');
  if (req.rawBody === null) return rejected(400, 'missing request body');
  const expected = Buffer.from(slackSignature(signingSecret.trim(), timestamp, req.rawBody).slice(3), 'hex');
  return equalBytes(Buffer.from(match[1], 'hex'), expected) ? { kind: 'verified' } : rejected(403, 'signature mismatch');
}
