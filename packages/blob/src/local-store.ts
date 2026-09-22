import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { assertSafeKey, type BlobObject, type BlobPutInput, type BlobStore } from './contract.js';

export interface LocalBlobStoreOptions {
  rootDir: string;
  /** Public base URL of the OCSO API, e.g. https://ocso.example.com/api */
  publicApiBaseUrl: string;
  /** HMAC key for signed download URLs. */
  signingKey: string;
}

interface Sidecar {
  contentType: string;
  sha256: string;
}

/**
 * Filesystem blob store for Compose (ADR-011). Signed URLs point at the API's
 * `/blobs/:key` route, which verifies the signature before streaming.
 */
export class LocalBlobStore implements BlobStore {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(private readonly options: LocalBlobStoreOptions) {
    this.root = resolve(options.rootDir);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid blob key');
    return full;
  }

  async put(input: BlobPutInput): Promise<BlobObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    await writeFile(path, input.data, { mode: 0o600 });
    const sidecar: Sidecar = { contentType: input.contentType, sha256 };
    await writeFile(`${path}.meta.json`, JSON.stringify(sidecar), { mode: 0o600 });
    return { key: input.key, contentType: input.contentType, sizeBytes: input.data.byteLength, sha256 };
  }

  async get(key: string): Promise<{ data: Uint8Array; contentType: string; sizeBytes: number }> {
    const path = this.pathFor(key);
    const [data, meta] = await Promise.all([readFile(path), readFile(`${path}.meta.json`, 'utf8')]);
    const sidecar = JSON.parse(meta) as Sidecar;
    return { data: new Uint8Array(data), contentType: sidecar.contentType, sizeBytes: data.byteLength };
  }

  async head(key: string): Promise<{ contentType: string; sizeBytes: number } | null> {
    const path = this.pathFor(key);
    try {
      const [info, meta] = await Promise.all([stat(path), readFile(`${path}.meta.json`, 'utf8')]);
      return { contentType: (JSON.parse(meta) as Sidecar).contentType, sizeBytes: info.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = signBlobUrl(this.options.signingKey, key, exp);
    const base = this.options.publicApiBaseUrl.replace(/\/$/, '');
    return `${base}/blobs/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`;
  }

  verifySignedGet(key: string, exp: number, sig: string, nowSeconds: number): boolean {
    return verifyBlobUrl(this.options.signingKey, key, exp, sig, nowSeconds);
  }
}

export function signBlobUrl(signingKey: string, key: string, exp: number): string {
  return createHmac('sha256', signingKey).update(`${key}\n${exp}`).digest('base64url');
}

/** Verify a signed blob URL (used by the API's blob route). */
export function verifyBlobUrl(signingKey: string, key: string, exp: number, sig: string, nowSeconds: number): boolean {
  if (!Number.isFinite(exp) || exp < nowSeconds) return false;
  const expected = Buffer.from(signBlobUrl(signingKey, key, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
