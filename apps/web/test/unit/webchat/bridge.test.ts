import { describe, expect, it } from 'vitest';
import { parseHostMessage, resolveHostOrigin } from '../../../lib/webchat/bridge';
import { frameAncestors, widgetCsp } from '../../../lib/webchat/frame-policy';
import { originAllowed } from '../../../lib/webchat/origins';

const HOST = 'https://shop.example.test';
const base = { framed: true, hostParam: HOST, ancestorOrigins: [HOST], referrer: `${HOST}/checkout`, allowedOrigins: [HOST] };

describe('widget ↔ host origin checks', () => {
  it('verifies the claimed host origin against the frame ancestors and the allowlist', () => {
    expect(resolveHostOrigin(base)).toEqual({ ok: true, origin: HOST });
    expect(resolveHostOrigin({ ...base, framed: false })).toEqual({ ok: false, reason: 'standalone' });
    expect(resolveHostOrigin({ ...base, hostParam: 'https://evil.test' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(resolveHostOrigin({ ...base, hostParam: 'https://evil.test', ancestorOrigins: ['https://evil.test'] })).toEqual({ ok: false, reason: 'not_allowed' });
    // Firefox has no ancestorOrigins: the referrer/host hint is used, and the allowlist still applies.
    expect(resolveHostOrigin({ ...base, ancestorOrigins: null, hostParam: null })).toEqual({ ok: true, origin: HOST });
    expect(resolveHostOrigin({ ...base, ancestorOrigins: null, hostParam: null, referrer: '' })).toEqual({ ok: false, reason: 'unknown' });
    // No allowlist configured: any embedding site gets a bridge bound to its own origin.
    expect(resolveHostOrigin({ ...base, allowedOrigins: [], hostParam: 'https://other.test', ancestorOrigins: ['https://other.test'] })).toEqual({ ok: true, origin: 'https://other.test' });
  });

  it('accepts commands only from the parent window at the verified origin', () => {
    const parent = {};
    const identify = { source: 'ocso-webchat-host', v: 1, type: 'identify', token: 'eyJhbGciOiJIUzI1NiJ9.e30.sig', requestId: 'r1' };
    expect(parseHostMessage({ origin: HOST, source: parent, data: identify }, HOST, parent)).toEqual({ type: 'identify', token: identify.token, requestId: 'r1' });
    expect(parseHostMessage({ origin: 'https://evil.test', source: parent, data: identify }, HOST, parent)).toBeNull();
    expect(parseHostMessage({ origin: HOST, source: {}, data: identify }, HOST, parent)).toBeNull();
    expect(parseHostMessage({ origin: HOST, source: parent, data: { ...identify, source: 'other' } }, HOST, parent)).toBeNull();
    expect(parseHostMessage({ origin: HOST, source: parent, data: { ...identify, token: 'x' } }, HOST, parent)).toBeNull();
    expect(parseHostMessage({ origin: HOST, source: parent, data: { source: 'ocso-webchat-host', v: 1, type: 'eval' } }, HOST, parent)).toBeNull();
    expect(parseHostMessage({ origin: HOST, source: parent, data: { source: 'ocso-webchat-host', v: 1, type: 'open' } }, HOST, parent)).toEqual({ type: 'open' });
  });

  it('matches allowlist entries exactly or by subdomain wildcard', () => {
    const list = ['https://shop.example.test', 'https://*.brand.test', 'http://localhost:5440'];
    expect(originAllowed('https://help.brand.test', list)).toBe(true);
    expect(originAllowed('https://brand.test', list)).toBe(false);
    expect(originAllowed('https://shop.example.test.evil.test', list)).toBe(false);
    expect(originAllowed('http://localhost:5440', list)).toBe(true);
    expect(originAllowed('http://localhost:5441', list)).toBe(false);
  });
});

describe('widget page frame policy', () => {
  it('derives frame-ancestors from the channel allowlist and fails closed', () => {
    expect(frameAncestors(['https://shop.example.test', 'https://*.brand.test'])).toBe("'self' https://shop.example.test https://*.brand.test");
    expect(frameAncestors([])).toBe('*');
    expect(frameAncestors(null)).toBe("'none'");
    expect(frameAncestors(["https://ok.test; script-src *"])).toBe("'none'");
    const csp = widgetCsp("'self' https://shop.example.test");
    expect(csp).toContain("frame-ancestors 'self' https://shop.example.test");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
