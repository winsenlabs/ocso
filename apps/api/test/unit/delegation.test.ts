import { describe, expect, it } from 'vitest';
import { DELEGATION_TTL_MS, DelegationTokens } from '../../src/common/delegation.js';

/**
 * Ask OCSO delegation tokens (PM/research/12 §6): only the private loopback listener, only the request they were
 * issued for, once, within 60 seconds, and only from this process's key.
 */
const grant = { userId: 'u1', sessionId: 's1', threadId: 't1', cardId: 'c1', method: 'PATCH', path: '/v1/teams/abc' };
const request = { method: 'PATCH', path: '/v1/teams/abc' };

function tokens(port = 40123) {
  const t = new DelegationTokens();
  t.setListenerPort(port);
  return t;
}

describe('delegation tokens', () => {
  it('accepts a fresh token once, on the internal listener from loopback, with its claims', () => {
    const t = tokens();
    const token = t.issue(grant);
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const fresh = t.issue(grant);
      expect(t.consume(fresh, { remoteAddress, localPort: 40123 }, request)).toMatchObject({ userId: 'u1', sessionId: 's1', threadId: 't1', cardId: 'c1' });
    }
    expect(t.consume(token, { remoteAddress: '127.0.0.1', localPort: 40123 }, request).userId).toBe('u1');
    expect(() => t.consume(token, { remoteAddress: '127.0.0.1', localPort: 40123 }, request)).toThrow(/already used/);
  });

  it('refuses another host, another listener, or no listener at all', () => {
    const t = tokens();
    expect(() => t.consume(t.issue(grant), { remoteAddress: '10.0.0.5', localPort: 40123 }, request)).toThrow(/not from loopback/);
    expect(() => t.consume(t.issue(grant), { remoteAddress: '::ffff:10.0.0.5', localPort: 40123 }, request)).toThrow(/not from loopback/);
    expect(() => t.consume(t.issue(grant), { remoteAddress: '127.0.0.1', localPort: 4000 }, request)).toThrow(/internal listener/);
    const closed = new DelegationTokens();
    expect(() => closed.consume(closed.issue(grant), { remoteAddress: '127.0.0.1', localPort: 40123 }, request)).toThrow(/internal listener/);
  });

  it('refuses an expired token, another request, a forged or foreign token', () => {
    const t = tokens();
    const now = Date.now();
    expect(() => t.consume(t.issue(grant, now - DELEGATION_TTL_MS - 1), { remoteAddress: '127.0.0.1', localPort: 40123 }, request, now)).toThrow(/expired/);
    expect(() => t.consume(t.issue(grant), { remoteAddress: '127.0.0.1', localPort: 40123 }, { method: 'DELETE', path: '/v1/teams/abc' })).toThrow(/another request/);
    expect(() => t.consume(t.issue(grant), { remoteAddress: '127.0.0.1', localPort: 40123 }, { method: 'PATCH', path: '/v1/users/abc' })).toThrow(/another request/);
    const [prefix, payload, signature] = t.issue(grant).split('.');
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), userId: 'someone-else' })).toString('base64url');
    expect(() => t.consume(`${prefix}.${tampered}.${signature}`, { remoteAddress: '127.0.0.1', localPort: 40123 }, request)).toThrow(/bad signature/);
    const other = tokens();
    expect(() => t.consume(other.issue(grant), { remoteAddress: '127.0.0.1', localPort: 40123 }, request)).toThrow(/bad signature/);
    expect(() => t.consume('not-a-token', { remoteAddress: '127.0.0.1', localPort: 40123 }, request)).toThrow(/malformed/);
  });
});
