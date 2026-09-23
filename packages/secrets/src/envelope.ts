import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for the local secret driver. The master key comes
 * from a mounted file or env var (base64, 32 bytes) and is never stored in
 * PostgreSQL. `aad` binds a ciphertext to its secret reference so rows cannot
 * be swapped between secrets.
 */
export interface Ciphertext {
  keyId: string;
  iv: string;
  tag: string;
  data: string;
}

export interface MasterKey {
  id: string;
  key: Buffer;
}

export function parseMasterKey(id: string, base64: string): MasterKey {
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== 32) throw new Error('secret master key must be 32 bytes (base64-encoded)');
  return { id, key };
}

export function encrypt(master: MasterKey, plaintext: string, aad: string): Ciphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId: master.id,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decrypt(keys: ReadonlyMap<string, MasterKey>, c: Ciphertext, aad: string): string {
  const master = keys.get(c.keyId);
  if (!master) throw new Error(`secret master key ${c.keyId} not available`);
  const decipher = createDecipheriv('aes-256-gcm', master.key, Buffer.from(c.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(c.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(c.data, 'base64')), decipher.final()]).toString('utf8');
}
