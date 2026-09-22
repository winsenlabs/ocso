import { createHmac } from 'node:crypto';

/** RFC 4648 base32 (the `secret` of an otpauth:// URI). */
function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the secret in an otpauth:// URI — what an authenticator app shows. */
export function totpFromUri(uri: string, now = Date.now()): string {
  const url = new URL(uri);
  const secret = base32(url.searchParams.get('secret') ?? '');
  const period = Number(url.searchParams.get('period') ?? 30);
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
