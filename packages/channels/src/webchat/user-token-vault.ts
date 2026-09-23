import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from './session-pass.js';

/**
 * Held user tokens (tool identity `passthrough`, SPEC §C.4): AES-256-GCM under
 * a key derived from the channel's secret key (HKDF info
 * `ocso-webchat-user-token`). Format `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * Rotating the secret key makes every held token unreadable, as intended.
 */

const INFO = 'ocso-webchat-user-token';
const VERSION = 'v1';

export function sealUserToken(token: string, secretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey, INFO), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** The token, or null when it cannot be opened (other key, tampered, unknown format). */
export function openUserToken(sealed: string, secretKey: string): string | null {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey, INFO), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
