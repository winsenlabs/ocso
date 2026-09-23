import { describe, expect, it } from 'vitest';
import { decideProvisioning, emailDomainMatches } from '../src/identity/auth/index.js';

describe('SSO provisioning policy (ADR-025)', () => {
  const base = { email: 'ana@corp.test', providerDomains: 'corp.test,subsidiary.test', autoProvision: false, existing: null };

  it('links an existing active user', () => {
    expect(decideProvisioning({ ...base, existing: { id: 'u1', status: 'ACTIVE' } })).toEqual({ action: 'link', userId: 'u1', profile: 'preserve' });
  });

  it('refuses a disabled user', () => {
    expect(decideProvisioning({ ...base, existing: { id: 'u1', status: 'DISABLED' } })).toMatchObject({ action: 'reject', code: 'account_disabled' });
  });

  it('refuses strangers unless auto-provisioning is on', () => {
    expect(decideProvisioning(base)).toMatchObject({ action: 'reject', code: 'sso_not_invited' });
    expect(decideProvisioning({ ...base, autoProvision: true })).toEqual({ action: 'continue' });
  });

  it('refuses addresses outside the provider domains, even for existing users', () => {
    const outside = { ...base, email: 'eve@evil.test', existing: { id: 'u9', status: 'ACTIVE' as const }, autoProvision: true };
    expect(decideProvisioning(outside)).toMatchObject({ action: 'reject', code: 'sso_domain_not_allowed' });
  });

  it('refuses when the IdP sends no email or the provider is unknown', () => {
    expect(decideProvisioning({ ...base, email: '' })).toMatchObject({ code: 'sso_email_missing' });
    expect(decideProvisioning({ ...base, providerDomains: null })).toMatchObject({ code: 'sso_provider_unknown' });
  });

  it('matches domains and subdomains only', () => {
    expect(emailDomainMatches('a@corp.test', 'corp.test')).toBe(true);
    expect(emailDomainMatches('a@eu.corp.test', 'corp.test')).toBe(true);
    expect(emailDomainMatches('a@evilcorp.test', 'corp.test')).toBe(false);
    expect(emailDomainMatches('a@CORP.TEST', ' corp.test , x.test')).toBe(true);
  });
});
