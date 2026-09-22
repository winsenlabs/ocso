import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '../src/index.js';

const key = (id: string) => parseMasterKey(id, randomBytes(32).toString('base64'));

describe('LocalSecretStore', () => {
  it('stores ciphertext only and resolves the plaintext', async () => {
    const rows = new InMemorySecretRows();
    const store = new LocalSecretStore(rows, key('k1'));
    const meta = await store.put({ name: 'Bedrock', kind: 'API_KEY', value: 'sk-very-secret' });
    expect(meta.ref).toMatch(/^sec_bedroc_[0-9a-f]{8}$/);
    expect(JSON.stringify(rows.raw(meta.ref))).not.toContain('sk-very-secret');
    expect(await store.resolve(meta.ref)).toBe('sk-very-secret');
  });

  it('never exposes values through describe/list', async () => {
    const store = new LocalSecretStore(new InMemorySecretRows(), key('k1'));
    const meta = await store.put({ name: 'wa', kind: 'CHANNEL_TOKEN', value: 'EAAG-token' });
    expect(JSON.stringify(await store.describe(meta.ref))).not.toContain('EAAG');
    expect(JSON.stringify(await store.list())).not.toContain('EAAG');
  });

  it('rotates values and bumps the version', async () => {
    const store = new LocalSecretStore(new InMemorySecretRows(), key('k1'));
    const meta = await store.put({ name: 'oai', kind: 'API_KEY', value: 'one' });
    const rotated = await store.rotate(meta.ref, 'two');
    expect(rotated.version).toBe(2);
    expect(rotated.rotatedAt).not.toBeNull();
    expect(await store.resolve(meta.ref)).toBe('two');
  });

  it('decrypts values written under a retired master key', async () => {
    const rows = new InMemorySecretRows();
    const oldKey = key('k1');
    const meta = await new LocalSecretStore(rows, oldKey).put({ name: 'x', kind: 'OTHER', value: 'legacy' });
    const store = new LocalSecretStore(rows, key('k2'), [oldKey]);
    expect(await store.resolve(meta.ref)).toBe('legacy');
  });

  it('binds ciphertext to its reference (rows cannot be swapped)', async () => {
    const rows = new InMemorySecretRows();
    const store = new LocalSecretStore(rows, key('k1'));
    const a = await store.put({ name: 'a', kind: 'OTHER', value: 'value-a' });
    const b = await store.put({ name: 'b', kind: 'OTHER', value: 'value-b' });
    await rows.update(b.ref, { ...rows.raw(b.ref)!, ciphertext: rows.raw(a.ref)!.ciphertext });
    await expect(store.resolve(b.ref)).rejects.toThrow();
  });

  it('rejects master keys of the wrong length', () => {
    expect(() => parseMasterKey('bad', Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});
