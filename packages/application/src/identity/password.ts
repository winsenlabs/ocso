import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Memory-hard password hashing with Node's built-in scrypt (no native addons).
 * Stored format: scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>
 */
const LOG_N = 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function scrypt(password: string, salt: Buffer, keyLen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keyLen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const optionsFor = (logN: number, r: number, p: number): ScryptOptions => ({
  N: 2 ** logN,
  r,
  p,
  maxmem: 256 * 2 ** logN * r,
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, optionsFor(LOG_N, R, P));
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, optionsFor(Number(logN), Number(r), Number(p)));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Password policy: length over composition rules (NIST SP 800-63B). */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters');
  if (password.length > 256) problems.push('must be at most 256 characters');
  if (/^(.)\1+$/.test(password)) problems.push('must not be a single repeated character');
  return problems;
}
