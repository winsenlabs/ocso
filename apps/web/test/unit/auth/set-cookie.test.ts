import { describe, expect, it } from 'vitest';
import { clientIpFromForwardedFor } from '../../../lib/client-ip-core';
import { authMessage } from '../../../lib/auth/messages';
import { isDeletion, parseSetCookie } from '../../../lib/auth/set-cookie';

describe('relaying Better Auth cookies', () => {
  it('parses a signed session cookie with its attributes and decodes the value once', () => {
    const cookie = parseSetCookie('__Secure-ocso.session_token=abc.d%2Be%3D; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax')!;
    expect(cookie).toMatchObject({ name: '__Secure-ocso.session_token', value: 'abc.d+e=', httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 86400 });
    expect(isDeletion(cookie)).toBe(false);
  });

  it('recognises deletions', () => {
    expect(isDeletion(parseSetCookie('ocso.session_token=; Max-Age=0; Path=/')!)).toBe(true);
    expect(isDeletion(parseSetCookie('ocso.two_factor=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT')!)).toBe(true);
    expect(parseSetCookie('garbage')).toBeNull();
  });
});

describe('client IP for rate limits', () => {
  it('takes the entry the trusted proxy appended, and nothing when the web is exposed directly', () => {
    expect(clientIpFromForwardedFor('6.6.6.6, 203.0.113.7', '1')).toBe('203.0.113.7');
    expect(clientIpFromForwardedFor('6.6.6.6, 203.0.113.7, 10.0.0.2', '2')).toBe('203.0.113.7');
    expect(clientIpFromForwardedFor('203.0.113.7', '0')).toBeUndefined();
    expect(clientIpFromForwardedFor('not-an-ip', '1')).toBeUndefined();
  });
});

describe('sign-in messages', () => {
  it('never reveals which part of the credentials was wrong', () => {
    expect(authMessage({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' })).toBe('Invalid email or password');
    expect(authMessage({ status: 429, code: null, message: null })).toMatch(/Too many attempts/);
    expect(authMessage({ status: 400, code: 'INVALID_TOKEN', message: 'x' })).toMatch(/invalid or has expired/);
  });
});
