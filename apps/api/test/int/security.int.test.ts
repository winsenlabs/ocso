import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerClaimsIssuer } from '@ocso/application';
import { customers, uuidv7 } from '@ocso/db';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

interface Verifier {
  verify(token: string): Promise<{ sub: string }>;
}

let h: ApiHarness;
let admin: string;
let makeVerifier: (issuer?: string) => Verifier;

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  // The demo tool server lives outside the API's tsconfig; load it at runtime.
  const mod = (await import(new URL('../../../../examples/mcp-bank-demo/src/claims-jwks.ts', import.meta.url).href)) as {
    JwksClaimsVerifier: new (o: { jwksUrl: string; issuer?: string; fetch: typeof fetch }) => Verifier;
  };
  const viaApi = (async () => {
    const res = await h.http().get('/.well-known/jwks.json');
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  makeVerifier = (issuer) => new mod.JwksClaimsVerifier({ jwksUrl: 'http://api/.well-known/jwks.json', ...(issuer ? { issuer } : {}), fetch: viaApi });
});
afterAll(async () => {
  await h?.close();
});

describe('customer claims keys (docs/08 §4)', () => {
  it('publishes only public keys, without authentication', async () => {
    const res = await h.http().get('/.well-known/jwks.json').expect(200);
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(res.body.keys[0]).not.toHaveProperty('d');
  });

  it('lets a tool server verify claims across a key rotation; rotation is Tech admin only', async () => {
    const issuer = h.app.get(CustomerClaimsIssuer);
    const customerId = uuidv7();
    await h.db.db.insert(customers).values({ id: customerId, externalRef: 'CIF-88214' });
    const input = { customerId, conversationId: uuidv7(), agentId: uuidv7(), connectionId: uuidv7(), scopes: [] };
    const before = await issuer.issue(input);
    const verifier = makeVerifier('http://localhost:3000');
    await expect(verifier.verify(before)).resolves.toMatchObject({ sub: 'CIF-88214' });
    await expect(makeVerifier('https://someone-else.example').verify(before)).rejects.toThrow('wrong issuer');

    const rotated = await h.http().post('/v1/security/signing-keys/rotate').set('authorization', `Bearer ${admin}`).expect(201);
    const after = await issuer.issue(input);
    expect(JSON.parse(Buffer.from(after.split('.')[0]!, 'base64url').toString()).kid).toBe(rotated.body.kid);
    // Fresh verifier (no cache) sees both keys; the pre-rotation token still verifies.
    const fresh = makeVerifier();
    await expect(fresh.verify(after)).resolves.toMatchObject({ sub: 'CIF-88214' });
    await expect(fresh.verify(before)).resolves.toMatchObject({ sub: 'CIF-88214' });

    const keys = await h.http().get('/v1/security/signing-keys').set('authorization', `Bearer ${admin}`).expect(200);
    expect(keys.body.map((k: { status: string }) => k.status).sort()).toEqual(['ACTIVE', 'RETIRING']);
    await h.http().post('/v1/security/signing-keys/rotate').expect(401);
  });

  it('lists secret metadata for Tech admins without ever returning values', async () => {
    const res = await h.http().get('/v1/secrets').set('authorization', `Bearer ${admin}`).expect(200);
    const claimsKey = res.body.find((s: { kind: string }) => s.kind === 'SIGNING_KEY');
    expect(claimsKey).toMatchObject({ usedBy: 'customer identity claims', state: 'ok' });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    expect(res.body.every((s: Record<string, unknown>) => !('value' in s) && !('ciphertext' in s))).toBe(true);
  });
});
