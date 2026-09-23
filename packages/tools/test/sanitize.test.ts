import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeForAudit, sanitizeSettingsForAudit } from '../src/sanitize.js';

const settings = {
  auth: { mode: 'user', allowNativeApps: false, userToken: { verify: 'jwks', jwksUrl: 'https://idp.test/jwks', issuer: 'https://idp.test', audience: 'chat' } },
  forwardUserToken: true,
};

describe('sanitizeForAudit (strict)', () => {
  it('redacts credential-looking keys', () => {
    expect(sanitizeForAudit({ password: 'x', apiKey: 'k', sessionPass: 'wsp1.a.b', userToken: 'eyJhbGciOi' })).toEqual({
      password: REDACTED,
      apiKey: REDACTED,
      sessionPass: REDACTED,
      userToken: REDACTED,
    });
  });

  it('keeps redacting objects and flags under auth-like keys (tool arguments and results)', () => {
    expect(sanitizeForAudit({ auth: { user: 'u', pass: 'p' } })).toEqual({ auth: REDACTED });
    expect(sanitizeForAudit({ auth: { method: 'otp', code: '482913', dob: '1990-01-01' } })).toEqual({ auth: REDACTED });
    expect(sanitizeForAudit({ result: { auth: { accessCode: 'x' } } })).toEqual({ result: { auth: REDACTED } });
    expect(sanitizeForAudit(settings)).toEqual({ auth: REDACTED, forwardUserToken: REDACTED });
  });
});

describe('sanitizeSettingsForAudit (configuration settings audits only)', () => {
  it('keeps web chat auth settings and the MCP forwardUserToken flag, which are configuration', () => {
    expect(sanitizeSettingsForAudit(settings)).toEqual(settings);
    expect(sanitizeSettingsForAudit({ settings, secretRefs: ['a'] })).toEqual({ settings, secretRefs: REDACTED });
  });

  it('still redacts a raw token, a number or a list under a configuration key name, and other secret keys inside', () => {
    expect(sanitizeSettingsForAudit({ auth: 'Bearer abc', userToken: 'eyJ.x.y', forwardUserToken: 1, auth2: {} })).toEqual({
      auth: REDACTED,
      userToken: REDACTED,
      forwardUserToken: REDACTED,
      auth2: REDACTED,
    });
    expect(sanitizeSettingsForAudit({ auth: ['token'] })).toEqual({ auth: REDACTED });
    expect(sanitizeSettingsForAudit({ auth: { mode: 'user', secret: 's', userToken: { hmacSecret: 'h', verify: 'hs256' } } })).toEqual({
      auth: { mode: 'user', secret: REDACTED, userToken: { hmacSecret: REDACTED, verify: 'hs256' } },
    });
  });
});
