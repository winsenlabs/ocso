import { invalidInbound } from '../common/errors.js';

/**
 * Twilio posts `application/x-www-form-urlencoded`. The signature covers the
 * decoded name/value pairs, so the raw body is decoded here (never the
 * framework's parsed object, whose nesting rules differ). Keys may repeat.
 */

export type FormPairs = ReadonlyArray<readonly [string, string]>;

/** Bodies are small (Twilio webhooks are a few KB); anything larger is refused before decoding. */
const MAX_FORM_BYTES = 256 * 1024;

export function parseFormPairs(rawBody: Buffer | null): FormPairs {
  if (rawBody === null || rawBody.byteLength === 0) return [];
  if (rawBody.byteLength > MAX_FORM_BYTES) throw invalidInbound('twilio_body_too_large', 'webhook body is too large');
  return [...new URLSearchParams(rawBody.toString('utf8')).entries()];
}

export type FormRecord = Readonly<Record<string, string | undefined>>;

/** First value per key (Twilio sends each parameter once); own properties only. */
export function formRecord(pairs: FormPairs): FormRecord {
  const first = new Map<string, string>();
  for (const [key, value] of pairs) if (!first.has(key)) first.set(key, value);
  return Object.fromEntries(first);
}
