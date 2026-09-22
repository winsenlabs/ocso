import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customers, signingKeys, uuidv7 } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { CustomerClaimsIssuer, systemActor, type PublicJwk } from '../src/index.js';

let t: TestDatabase;
let secrets: LocalSecretStore;
let clock = new Date('2026-09-22T10:00:00Z');
const input = { customerId: '', conversationId: uuidv7(), agentId: uuidv7(), connectionId: uuidv7(), scopes: ['payments.write', 'cards.read'] };
const actor = systemActor('test', 'c');

beforeAll(async () => {
  t = await createTestDatabase();
  secrets = new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k1', randomBytes(32).toString('base64')));
  input.customerId = uuidv7();
  await t.db.insert(customers).values({ id: input.customerId, displayName: 'Priya Deshmukh', externalRef: 'CIF-88214' });
});
afterAll(async () => {
  await t?.drop();
});

const issuer = () => new CustomerClaimsIssuer({ db: t.db, secrets, issuer: 'https://support.meridian.test', now: () => clock });

function decode(token: string) {
  const [h, p, s] = token.split('.') as [string, string, string];
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(p, 'base64url').toString()), signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
}

function verifiesWith(token: string, keys: PublicJwk[]): boolean {
  const { header, signingInput, signature } = decode(token);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  return verify('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature);
}

describe('customer identity claims (docs/08 §4, E5.6)', () => {
  it('issues a minimal, short-lived ES256 JWT verifiable through the JWKS', async () => {
    const token = await issuer().issue(input);
    const { header, payload } = decode(token);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(Object.keys(payload).sort()).toEqual(['agt', 'aud', 'cid', 'exp', 'iat', 'iss', 'jti', 'nbf', 'scope', 'sub']);
    expect(payload).toMatchObject({ iss: 'https://support.meridian.test', sub: 'CIF-88214', aud: `ocso-mcp:${input.connectionId}`, cid: input.conversationId, agt: input.agentId, scope: 'cards.read payments.write' });
    expect(payload.exp - payload.iat).toBe(120);
    expect(JSON.stringify(payload)).not.toContain('Priya');

    const jwks = await issuer().jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty('d');
    expect(verifiesWith(token, jwks.keys)).toBe(true);
    expect(verifiesWith(token.slice(0, -4) + 'AAAA', jwks.keys)).toBe(false);
  });

  it('uses an opaque subject when the business reference is unknown', async () => {
    const anonymous = uuidv7();
    await t.db.insert(customers).values({ id: anonymous, displayName: null });
    const { payload } = decode(await issuer().issue({ ...input, customerId: anonymous }));
    expect(payload.sub).toBe(`ocso:customer:${anonymous}`);
  });

  it('creates exactly one active key when instances race on first use', async () => {
    await t.db.delete(signingKeys);
    await Promise.all(Array.from({ length: 5 }, () => issuer().issue(input)));
    const rows = await t.db.select().from(signingKeys).where(eq(signingKeys.status, 'ACTIVE'));
    expect(rows).toHaveLength(1);
  });

  it('rotates without breaking tokens already issued, then retires the old key', async () => {
    const a = issuer();
    const before = await a.issue(input);
    const { kid } = await a.rotate(actor);
    const after = await a.issue(input);
    expect(decode(after).header.kid).toBe(kid);
    expect(decode(before).header.kid).not.toBe(kid);

    const jwks = await a.jwks();
    expect(jwks.keys.map((k) => k.kid)).toContain(kid);
    expect(verifiesWith(before, jwks.keys)).toBe(true);
    expect(verifiesWith(after, jwks.keys)).toBe(true);

    const [retiring] = await t.db.select().from(signingKeys).where(eq(signingKeys.status, 'RETIRING'));
    clock = new Date(clock.getTime() + 25 * 3600 * 1000);
    expect(await a.retireExpired()).toBe(1);
    expect((await a.jwks()).keys.map((k) => k.kid)).toEqual([kid]);
    await expect(secrets.resolve(retiring!.privateKeyRef)).rejects.toThrow();
    const { rows } = await t.pool.query(`SELECT action FROM audit_events WHERE action = 'security.signing_key_rotated'`);
    expect(rows).toHaveLength(1);
  });
});
