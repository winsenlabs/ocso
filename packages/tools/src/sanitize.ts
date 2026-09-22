/**
 * Redaction for tool-call audit payloads, logs and traces (build rule §21).
 * Keys that look like credentials are replaced; long strings are truncated.
 */
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|auth|cookie|session|private[-_]?key|cvv|cvc|pin|otp)/i;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;
const MAX_STRING = 2_000;
const MAX_DEPTH = 8;
const MAX_ARRAY = 100;

export const REDACTED = '[REDACTED]';

export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    const masked = value.replace(CARD_NUMBER, (m) => `••••${m.replace(/\D/g, '').slice(-4)}`);
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitizeForAudit(v, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `[+${value.length - MAX_ARRAY} more]`] : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? REDACTED : sanitizeForAudit(v, depth + 1),
      ]),
    );
  }
  return value;
}
