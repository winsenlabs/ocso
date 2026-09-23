import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying `sha256=<hex HMAC-SHA256 of the raw body>`, in both directions. */
export const SIGNATURE_HEADER = 'x-ocso-signature';

export function sign(secret: string, body: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time comparison of a received signature with the expected one. */
export function signatureMatches(secret: string, body: Uint8Array, received: string | undefined): boolean {
  if (!received) return false;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(received.trim());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
