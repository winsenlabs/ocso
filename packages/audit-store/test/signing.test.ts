import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkpointMessage, generateSigningKeyPem, loadSigningKey, parsePublicKey, parsePublicKeys, publicKeyOf, signCheckpoint, trustedKeys, verifyCheckpoint, verifySignature } from '../src/signing.js';

const signer = loadSigningKey(generateSigningKeyPem());
const at = { upToPosition: 1000, chainHash: 'a'.repeat(64) };

describe('Ed25519 audit signing', () => {
  it('signs checkpoints that verify with the public key alone', () => {
    const c = signCheckpoint(signer, at, new Date('2026-09-23T10:00:00.123Z'), 'cp-1');
    expect(checkpointMessage(c)).toBe(`ocso-audit-checkpoint\n1000\n${'a'.repeat(64)}\n2026-09-23T10:00:00.123Z`);
    const published = parsePublicKey(signer.publicKeyPem);
    expect(published).toEqual(publicKeyOf(signer));
    expect(verifyCheckpoint(c, [published])).toBe('VALID');
    expect(verifySignature(published.publicKeyPem, checkpointMessage(c), c.signature)).toBe(true);
  });

  it('rejects any change to a signed checkpoint, and says when the key is not trusted', () => {
    const c = signCheckpoint(signer, at);
    const keys = [publicKeyOf(signer)];
    expect(verifyCheckpoint({ ...c, upToPosition: 1001 }, keys)).toBe('INVALID');
    expect(verifyCheckpoint({ ...c, chainHash: 'b'.repeat(64) }, keys)).toBe('INVALID');
    expect(verifyCheckpoint({ ...c, createdAt: new Date(c.createdAt.getTime() + 1) }, keys)).toBe('INVALID');
    expect(verifyCheckpoint({ ...c, signature: 'AAAA' }, keys)).toBe('INVALID');
    expect(verifyCheckpoint(c, [publicKeyOf(loadSigningKey(generateSigningKeyPem()))])).toBe('UNKNOWN_KEY');
  });

  it('derives a stable 16-hex key id and refuses keys that are not Ed25519', () => {
    const pem = generateSigningKeyPem();
    expect(loadSigningKey(pem).keyId).toBe(loadSigningKey(pem).keyId);
    expect(loadSigningKey(pem).keyId).toMatch(/^[0-9a-f]{16}$/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadSigningKey(rsa)).toThrow(/Ed25519/);
  });

  it('trusts the current key and retired ones from a PEM bundle, each once', () => {
    const current = loadSigningKey(generateSigningKeyPem());
    const retired = loadSigningKey(generateSigningKeyPem());
    const bundle = `${retired.publicKeyPem}\n${current.publicKeyPem}`;
    expect(parsePublicKeys(bundle).map((k) => k.keyId)).toEqual([retired.keyId, current.keyId]);
    expect(() => parsePublicKeys('not a key')).toThrow(/no PEM public key/);
    expect(parsePublicKeys('')).toEqual([]);
    const signer = { ...current, retiredKeys: parsePublicKeys(bundle) };
    expect(trustedKeys(signer).map((k) => k.keyId)).toEqual([current.keyId, retired.keyId]);
    expect(trustedKeys(null)).toEqual([]);
  });
});
