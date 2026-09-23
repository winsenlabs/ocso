import { describe, expect, it } from 'vitest';
import {
  alertEmail,
  coarseIp,
  emailVerificationEmail,
  formatDateTime,
  inviteEmail,
  newSignInEmail,
  passwordChangedEmail,
  passwordResetEmail,
  signInCodeEmail,
  type RenderedEmail,
} from '../src/index.js';

const NOW = new Date('2026-09-22T10:00:00.000Z');
const EVIL = `<script>alert("x")</script> & 'Co'`;
const base = { org: 'Meridian Bank', now: NOW };

/** Structural guarantees every template must meet. */
function assertSafe(email: RenderedEmail): void {
  expect(email.subject).not.toMatch(/[\r\n]/);
  expect(email.text.trim().length).toBeGreaterThan(20);
  expect(email.text).toContain('Sent by OCSO for');
  expect(email.html).toContain('Sent by OCSO for');
  expect(email.html).not.toMatch(/<script|<img|<link|<iframe|src=|url\(|@import/i);
  expect(email.html).toMatch(/^<!DOCTYPE html>/);
}

describe('account email templates', () => {
  it('invite: escaped names, accept link, role, expiry, text alternative', () => {
    const email = inviteEmail({
      ...base,
      org: `Meridian ${EVIL}`,
      inviterName: `Tarun ${EVIL}`,
      recipientEmail: 'meera@meridian.test',
      recipientName: 'Meera',
      roleLabel: `Service member ${EVIL}`,
      acceptUrl: 'https://ocso.meridian.test/invite/accept?token=abc&x=1',
      expiresAt: new Date('2026-09-29T10:00:00.000Z'),
    });
    assertSafe(email);
    expect(email.subject).toBe(`Tarun ${EVIL} invited you to Meridian ${EVIL} on OCSO`);
    expect(email.html).toContain('Tarun &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;');
    expect(email.html).toContain('href="https://ocso.meridian.test/invite/accept?token=abc&amp;x=1"');
    expect(email.text).toContain('Accept invitation: https://ocso.meridian.test/invite/accept?token=abc&x=1');
    expect(email.text).toContain('This invitation expires in 7 days (29 Sep 2026, 10:00 UTC).');
    expect(email.text).toContain('Hi Meera,');
    expect(email.text).toContain(`as Service member ${EVIL}.`);
  });

  it('refuses dangerous links and neutralizes markup inside URLs', () => {
    const input = { ...base, recipientName: null, expiresAt: new Date('2026-09-22T11:00:00.000Z') };
    for (const resetUrl of ['javascript:alert(1)', 'data:text/html,<b>x</b>', '/relative/path', 'https://user:pw@ocso.test/reset']) {
      expect(() => passwordResetEmail({ ...input, resetUrl }), resetUrl).toThrow(/link/);
    }
    const email = passwordResetEmail({ ...input, resetUrl: 'https://ocso.test/reset/"><script>alert(1)</script>?q="onmouseover=x' });
    assertSafe(email);
    expect(email.html).not.toContain('"><script>');
    expect(email.html).not.toContain('"onmouseover');
    expect(email.html).toContain('https://ocso.test/reset/%22%3E%3Cscript%3Ealert(1)%3C/script%3E?q=%22onmouseover=x');
    expect(email.text).toContain('If you did not ask for this, ignore this email. Your password stays the same.');
    expect(email.text).toContain('The link expires in 60 minutes');
  });

  it('password reset and verification carry their links in both parts', () => {
    const reset = passwordResetEmail({ ...base, resetUrl: 'https://ocso.test/reset/t1', expiresAt: new Date('2026-09-22T10:30:00.000Z'), timeZone: 'Asia/Kolkata' });
    assertSafe(reset);
    expect(reset.subject).toBe('Reset your OCSO password');
    expect(reset.text).toContain('Choose a new password: https://ocso.test/reset/t1');
    expect(reset.text).toContain('in 30 minutes (22 Sep 2026, 16:00 GMT+5:30)');
    const verify = emailVerificationEmail({ ...base, recipientEmail: 'meera@meridian.test', verifyUrl: 'https://ocso.test/verify/v1' });
    assertSafe(verify);
    expect(verify.subject).toBe('Verify your email address for OCSO');
    expect(verify.text).toContain('Verify email address: https://ocso.test/verify/v1');
    expect(verify.text).toContain('Confirm that meera@meridian.test is your address');
    expect(verify.text).not.toContain('expires');
  });

  it('sign-in code: code in the body only, never in subject or preview', () => {
    const email = signInCodeEmail({ ...base, code: '482913', expiresAt: new Date('2026-09-22T10:10:00.000Z') });
    assertSafe(email);
    expect(email.subject).toBe('Your OCSO sign-in code');
    expect(email.text).toContain('    482913');
    expect(email.html).toContain('>482913</p>');
    expect(email.html.split('482913')).toHaveLength(2);
    expect(email.text).toContain('The code expires in 10 minutes');
    expect(signInCodeEmail({ ...base, code: '<b>1</b>', expiresAt: NOW }).html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });

  it('password changed: security notice with or without a reset link', () => {
    const withLink = passwordChangedEmail({ ...base, changedAt: NOW, resetUrl: 'https://ocso.test/forgot' });
    assertSafe(withLink);
    expect(withLink.text).toContain('was changed on 22 Sep 2026, 10:00 UTC');
    expect(withLink.text).toContain('Reset password: https://ocso.test/forgot');
    const without = passwordChangedEmail({ ...base, changedAt: NOW });
    expect(without.text).toContain('contact your OCSO administrator right away');
    expect(without.html).not.toContain('href=');
  });

  it('new sign-in: time, coarse network and device only', () => {
    const email = newSignInEmail({ ...base, at: NOW, ipAddress: '203.0.113.77', userAgent: `Mozilla/5.0 ${EVIL}`, securityUrl: 'https://ocso.test/account' });
    assertSafe(email);
    expect(email.text).toContain('Network: 203.0.113.x');
    expect(email.text).not.toContain('203.0.113.77');
    expect(email.html).toContain('Mozilla/5.0 &lt;script&gt;');
    expect(email.text).toContain('Review account security: https://ocso.test/account');
    const bare = newSignInEmail({ ...base, at: NOW });
    expect(bare.text).not.toContain('Network:');
  });
});

describe('alert email', () => {
  it('renders severity tag, summary, fields and link with escaping', () => {
    const email = alertEmail({
      org: 'Meridian Bank · PROD',
      title: `Provider error rate above 5% ${EVIL}`,
      severity: 'critical',
      summary: `12 of 150 requests failed\n${EVIL}`,
      fields: [['Severity', 'Critical'], ['Source', `Provider ${EVIL}`]],
      link: 'https://ocso.test/alerts/a1',
      reference: 'Alert a1',
    });
    assertSafe(email);
    expect(email.subject).toBe(`[OCSO CRITICAL] Provider error rate above 5% ${EVIL}`);
    expect(email.html).toContain('12 of 150 requests failed<br>&lt;script&gt;');
    expect(email.text).toContain('Severity: Critical');
    expect(email.text).toContain('Open in OCSO: https://ocso.test/alerts/a1');
    expect(alertEmail({ org: 'X', title: 't', severity: 'RESOLVED', summary: 's' }).html).not.toContain('href=');
  });
});

describe('formatting helpers', () => {
  it('coarsens IPs and formats dates deterministically', () => {
    expect(coarseIp('198.51.100.23')).toBe('198.51.100.x');
    expect(coarseIp('::ffff:198.51.100.23')).toBe('198.51.100.x');
    expect(coarseIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::/48');
    expect(coarseIp('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(coarseIp('garbage')).toBe('unknown network');
    expect(formatDateTime(NOW, 'Not/AZone')).toBe('22 Sep 2026, 10:00 UTC');
  });
});
