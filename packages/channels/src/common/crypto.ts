import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Small crypto helpers shared by channel verification code. */

export function hmacSha256(secret: string, data: Buffer | string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Constant-time comparison of two byte strings (false on length mismatch). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * Constant-time string comparison that does not leak the secret's length:
 * both sides are hashed to fixed-size digests before comparing.
 */
export function equalSecrets(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64UrlEncode(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');
}

/** Strict base64url decode; returns null for any non-base64url input. */
export function base64UrlDecode(value: string): Buffer | null {
  return BASE64URL.test(value) ? Buffer.from(value, 'base64url') : null;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;
const BASE64_SHA256 = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * Providers disagree on digest encoding (Meta webhooks send base64, some
 * APIs hex). Normalizes either to lower-case hex; undefined when unusable.
 */
export function normalizeSha256(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (HEX_SHA256.test(value)) return value.toLowerCase();
  if (!BASE64_SHA256.test(value)) return undefined;
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.byteLength === 32 ? bytes.toString('hex') : undefined;
}
