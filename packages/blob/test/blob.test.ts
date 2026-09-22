import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalBlobStore, checkMedia, mediaKey, sniffMime, verifyBlobUrl } from '../src/index.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const dirs: string[] = [];

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'ocso-blob-'));
  dirs.push(dir);
  return new LocalBlobStore({ rootDir: dir, publicApiBaseUrl: 'https://ocso.test/api', signingKey: 'k' });
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('LocalBlobStore', () => {
  it('round-trips bytes with content type and sha256', async () => {
    const s = await store();
    const obj = await s.put({ key: 'media/2026/09/c1/a.jpg', data: JPEG, contentType: 'image/jpeg' });
    expect(obj.sha256).toHaveLength(64);
    const got = await s.get(obj.key);
    expect(Array.from(got.data)).toEqual(Array.from(JPEG));
    expect(got.contentType).toBe('image/jpeg');
    expect(await s.head(obj.key)).toEqual({ contentType: 'image/jpeg', sizeBytes: JPEG.length });
    await s.delete(obj.key);
    expect(await s.head(obj.key)).toBeNull();
  });

  it('rejects keys that could escape the root', async () => {
    const s = await store();
    for (const key of ['../etc/passwd', 'media/../../x', '/abs', 'a//b']) {
      await expect(s.put({ key, data: JPEG, contentType: 'image/jpeg' })).rejects.toThrow(/invalid blob key/);
    }
  });

  it('issues signed URLs that verify and expire', async () => {
    const s = await store();
    const url = new URL(await s.signedGetUrl('media/2026/09/c1/a.jpg', 60));
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    const now = Math.floor(Date.now() / 1000);
    expect(verifyBlobUrl('k', 'media/2026/09/c1/a.jpg', exp, sig, now)).toBe(true);
    expect(verifyBlobUrl('k', 'media/2026/09/c1/b.jpg', exp, sig, now)).toBe(false);
    expect(verifyBlobUrl('other', 'media/2026/09/c1/a.jpg', exp, sig, now)).toBe(false);
    expect(verifyBlobUrl('k', 'media/2026/09/c1/a.jpg', exp, sig, exp + 1)).toBe(false);
  });
});

describe('media checks', () => {
  it('sniffs common types', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('rejects content that does not match an allowed type', () => {
    expect(checkMedia(JPEG, 'image/jpeg', ['image/jpeg'], 1000).ok).toBe(true);
    expect(checkMedia(PDF, 'image/jpeg', ['image/jpeg'], 1000)).toMatchObject({ ok: false, reason: 'type_not_allowed' });
    expect(checkMedia(JPEG, 'image/jpeg', ['image/jpeg'], 4)).toMatchObject({ ok: false, reason: 'too_large' });
    expect(checkMedia(new Uint8Array([9, 9, 9]), 'image/png', ['image/png'], 1000)).toMatchObject({
      ok: false,
      reason: 'unrecognized_content',
    });
  });

  it('builds date-partitioned media keys', () => {
    expect(mediaKey('conv1', 'm1', 'jpg', new Date('2026-09-22T00:00:00Z'))).toBe('media/2026/09/conv1/m1.jpg');
  });
});
