import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from '../../../lib/same-origin';

const req = (headers: Record<string, string>) => new Request('http://ocso.internal:3000/api/internal-agent/chat', { method: 'POST', headers });

describe('isSameOriginRequest (CSRF defence in depth)', () => {
  it('trusts Sec-Fetch-Site when the browser sends it', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-site', origin: 'https://evil.bank.example' }))).toBe(false);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('falls back to Origin against the forwarded host', () => {
    expect(isSameOriginRequest(req({ origin: 'https://support.bank.example', 'x-forwarded-host': 'support.bank.example', 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'https://promo.bank.example', 'x-forwarded-host': 'support.bank.example', 'x-forwarded-proto': 'https' }))).toBe(false);
  });

  it('rejects requests without any origin signal', () => {
    expect(isSameOriginRequest(req({}))).toBe(false);
  });
});
