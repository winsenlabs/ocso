import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the webhook signature: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const SIGNATURE_HEADER = 'X-OCSO-Signature';

/** HMAC-SHA256 over `${timestamp}.${body}` — binds the timestamp to prevent replays. */
export function computeSignature(secret: string, body: string, timestampSeconds: number): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
}

export function signatureHeader(secret: string, body: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, body, timestampSeconds)}`;
}

export interface VerifyOptions {
  nowSeconds: number;
  /** Maximum accepted clock skew / replay window. Default 300 s. */
  toleranceSeconds?: number | undefined;
}

/**
 * Receiver-side verification (documented for integrators and used in tests):
 * constant-time comparison and a bounded timestamp window.
 */
export function verifySignature(header: string | null | undefined, body: string, secret: string, options: VerifyOptions): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(',').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(options.nowSeconds - t) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(computeSignature(secret, body, t), 'hex');
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
