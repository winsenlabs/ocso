import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server actions and the Better Auth browser client are not part of these renders.
vi.mock('../../../lib/actions/auth', () => ({ loginAction: vi.fn(), verifyMfaAction: vi.fn(), setPasswordAction: vi.fn(), forgotPasswordAction: vi.fn() }));
vi.mock('../../../lib/actions/account', () => ({ startEnrollmentAction: vi.fn(), confirmEnrollmentAction: vi.fn() }));
vi.mock('../../../lib/auth-client', () => ({ authClient: { signIn: { passkey: vi.fn(), sso: vi.fn() }, passkey: { addPasskey: vi.fn() } } }));

const { LoginForm } = await import('../../../components/auth/login-form');
const { MfaStep } = await import('../../../components/auth/mfa-step');
const { SetPasswordForm } = await import('../../../components/auth/set-password-form');
const { MfaEnrollment } = await import('../../../components/account/mfa-enrollment');
const { InviteLink } = await import('../../../components/team/invite-link');

describe('sign-in forms (ADR-025)', () => {
  it('password step: email, password, forgot link and a passkey option; SSO only when a provider exists', () => {
    const without = renderToStaticMarkup(createElement(LoginForm, { next: '/team', sso: false }));
    expect(without).toContain('name="email"');
    expect(without).toContain('type="password"');
    expect(without).toContain('href="/forgot-password"');
    expect(without).toContain('Use a passkey');
    expect(without).not.toContain('single sign-on');
    expect(without).toContain('value="/team"');
    expect(renderToStaticMarkup(createElement(LoginForm, { next: '/', sso: true }))).toContain('Continue with single sign-on');
  });

  it('second step asks for the authenticator code and keeps where to go next', () => {
    const html = renderToStaticMarkup(createElement(MfaStep, { next: '/queues', email: 'lead@ocso.test' }));
    expect(html).toContain('Authentication code');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('value="/queues"');
    expect(html).toContain('Use a backup code');
    expect(html).not.toContain('type="password"');
  });

  it('set-password form carries the single-use token and asks twice', () => {
    const html = renderToStaticMarkup(createElement(SetPasswordForm, { token: 'tok_123', purpose: 'invite' }));
    expect(html).toContain('value="tok_123"');
    expect(html).toContain('value="invite"');
    expect(html).toContain('Confirm password');
    expect(html).toContain('Set password and continue');
  });

  it('MFA enrolment asks for the password only when the account has one, and yields to the enabled view', () => {
    expect(renderToStaticMarkup(createElement(MfaEnrollment, { hasPassword: true, enabled: false, whenEnabled: null }))).toContain('Current password');
    expect(renderToStaticMarkup(createElement(MfaEnrollment, { hasPassword: false, enabled: false, whenEnabled: null }))).not.toContain('Current password');
    expect(renderToStaticMarkup(createElement(MfaEnrollment, { hasPassword: true, enabled: true, whenEnabled: 'MANAGE' }))).toBe('MANAGE');
  });

  it('shows a hand-over link read-only with a warning', () => {
    const html = renderToStaticMarkup(createElement(InviteLink, { link: 'http://localhost:3000/invite?token=abc', note: 'Email is not configured' }));
    expect(html).toMatch(/readOnly|readonly/);
    expect(html).toContain('http://localhost:3000/invite?token=abc');
    expect(html).toContain('Email is not configured');
  });
});
