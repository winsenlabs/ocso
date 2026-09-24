import { SlackUrlVerification } from './schema.js';

/**
 * Slack posts two body shapes to the same Request URL: Events API callbacks
 * as JSON, interactivity as `application/x-www-form-urlencoded` with the JSON
 * in `payload`. Both decode to a JSON value here (null when unreadable).
 */

const MAX_BODY_BYTES = 1024 * 1024;

export function slackJsonBody(rawBody: Buffer | null): unknown {
  if (!rawBody?.byteLength || rawBody.byteLength > MAX_BODY_BYTES) return null;
  const text = rawBody.toString('utf8').trim();
  try {
    if (text.startsWith('{')) return JSON.parse(text) as unknown;
    const payload = new URLSearchParams(text).get('payload');
    return payload ? (JSON.parse(payload) as unknown) : null;
  } catch {
    return null;
  }
}

/** Slack's challenge is a short token; anything else is refused rather than reflected. */
const SAFE_CHALLENGE = /^[A-Za-z0-9._~-]{1,256}$/;

/** The challenge of a `url_verification` request; `undefined` = not one, `null` = one with an unsafe challenge. */
export function urlVerificationChallenge(body: unknown): string | null | undefined {
  const parsed = SlackUrlVerification.safeParse(body);
  if (!parsed.success) return undefined;
  return SAFE_CHALLENGE.test(parsed.data.challenge) ? parsed.data.challenge : null;
}
