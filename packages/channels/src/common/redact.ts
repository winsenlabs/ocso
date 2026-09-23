/**
 * Last-line redaction for provider-supplied text that ends up in error
 * messages (build rule §21). Known secrets are replaced verbatim; bearer
 * tokens and token-like query parameters are masked by pattern.
 */

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_PARAM = /\b(access_token|appsecret_proof|token|signature)=[^&\s"']+/gi;
const MIN_SECRET_LENGTH = 6;

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED);
  }
  return out.replace(BEARER, `Bearer ${REDACTED}`).replace(TOKEN_PARAM, `$1=${REDACTED}`);
}

/** Redact, collapse whitespace and bound the length of provider text. */
export function safeProviderText(text: string | undefined, secrets: readonly (string | undefined)[], max = 300): string {
  if (!text) return '';
  const clean = redactSecrets(text, secrets).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
