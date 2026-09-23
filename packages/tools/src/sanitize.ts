/**
 * Redaction for tool-call audit payloads, logs and traces (build rule §21).
 * Keys that look like credentials are replaced; long strings are truncated.
 */
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|auth|cookie|session|private[-_]?key|cvv|cvc|pin|otp)/i;
/**
 * Settings keys that match SECRET_KEY but hold configuration, not credentials (web chat `auth` settings, an MCP
 * connection's `forwardUserToken` flag). Only `sanitizeSettingsForAudit` keeps them, and only when the value is an
 * object or a boolean, so a raw token under the same key is still redacted.
 */
const CONFIG_KEYS = new Set(['auth', 'userToken', 'forwardUserToken']);
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;
const MAX_STRING = 2_000;
const MAX_DEPTH = 8;
const MAX_ARRAY = 100;

export const REDACTED = '[REDACTED]';

const isConfigValue = (v: unknown) => typeof v === 'boolean' || (typeof v === 'object' && v !== null && !Array.isArray(v));

function sanitize(value: unknown, depth: number, settings: boolean): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') {
    const masked = value.replace(CARD_NUMBER, (m) => `••••${m.replace(/\D/g, '').slice(-4)}`);
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1, settings));
    return value.length > MAX_ARRAY ? [...items, `[+${value.length - MAX_ARRAY} more]`] : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) && !(settings && CONFIG_KEYS.has(k) && isConfigValue(v)) ? REDACTED : sanitize(v, depth + 1, settings),
      ]),
    );
  }
  return value;
}

/** Strict redaction: every credential-looking key is replaced, whatever its value (tool arguments and results, audit payloads). */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  return sanitize(value, depth, false);
}

/**
 * Redaction for audit rows of configuration settings only (channel create/update, MCP connection policy): as
 * `sanitizeForAudit`, except that `auth`, `userToken` and `forwardUserToken` are kept when their value is an object
 * or a boolean (settings, not credentials). Never use it for tool-call arguments or results.
 */
export function sanitizeSettingsForAudit(value: unknown): unknown {
  return sanitize(value, 0, true);
}
