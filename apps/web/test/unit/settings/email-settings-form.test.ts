import { describe, expect, it } from 'vitest';
import { deliveryStatus, describeTestResult, parseTestRecipient, statusNotes, type EmailSettings } from '../../../lib/email-settings-form';

const settings = (overrides: Partial<EmailSettings> = {}): EmailSettings => ({
  driver: 'resend',
  label: 'Resend',
  from: 'Meridian Support <support@meridian.test>',
  replyTo: null,
  configured: true,
  warnings: [],
  ...overrides,
});

describe('email settings: test recipient', () => {
  it('trims and accepts one plain address', () => {
    expect(parseTestRecipient('  ops@meridian.test ')).toEqual({ ok: true, to: 'ops@meridian.test' });
  });

  it('rejects empty, display-name, multiple and oversized input', () => {
    expect(parseTestRecipient('   ')).toEqual({ ok: false, error: 'Enter the address to send the test email to' });
    expect(parseTestRecipient('Ops <ops@meridian.test>').ok).toBe(false);
    expect(parseTestRecipient('a@meridian.test, b@meridian.test').ok).toBe(false);
    expect(parseTestRecipient('no-at-sign.test').ok).toBe(false);
    expect(parseTestRecipient(`${'a'.repeat(320)}@meridian.test`)).toEqual({ ok: false, error: 'At most 320 characters' });
  });
});

describe('email settings: test result text', () => {
  it('reports a delivered test with the provider id', () => {
    expect(describeTestResult({ ok: true, driver: 'resend', label: 'Resend', delivers: true, id: 're_123' })).toEqual({ tone: 'info', message: 'Test email sent via Resend · message id re_123.' });
    expect(describeTestResult({ ok: true, driver: 'smtp', label: 'SMTP', id: null, warning: 'Reply-to is not set.' })).toEqual({
      tone: 'warn',
      message: 'Test email sent via SMTP. Reply-to is not set.',
    });
  });

  it('never presents a non-delivering driver as delivered', () => {
    const r = describeTestResult({ ok: true, driver: 'log', label: 'Log — development only', delivers: false, id: null, warning: 'Nothing was delivered.' });
    expect(r.tone).toBe('warn');
    expect(r.message).toMatch(/^Not delivered: the log driver/);
    expect(r.message).toContain('Nothing was delivered.');
  });

  it('renders a driver it has never heard of (open driver names, older APIs without a label)', () => {
    expect(describeTestResult({ ok: true, driver: 'postbox', id: 'pb-1' })).toEqual({ tone: 'info', message: 'Test email sent via postbox · message id pb-1.' });
    expect(deliveryStatus(settings({ driver: 'postbox', label: undefined }))).toEqual({ tone: 'good', label: 'delivering' });
  });

  it('explains failures by category and includes the safe provider reason', () => {
    const auth = describeTestResult({ ok: false, driver: 'resend', id: null, category: 'auth', error: 'HTTP 403 validation_error', retriable: false });
    expect(auth.tone).toBe('error');
    expect(auth.message).toContain('sending domain is verified');
    expect(auth.message).toContain('(HTTP 403 validation_error)');
    expect(auth.message).not.toContain('retry');

    expect(describeTestResult({ ok: false, driver: 'resend', id: null, category: 'rate_limited', retriable: true }).message).toBe('Rate limit or sending quota reached. Try again shortly.');
    expect(describeTestResult({ ok: false, driver: 'smtp', id: null, category: 'network', retriable: true }).message).toContain('A retry may succeed.');
  });

  it('falls back to a generic message for unknown or missing categories', () => {
    expect(describeTestResult({ ok: false, driver: 'smtp', id: null }).message).toBe('Sending failed.');
    expect(describeTestResult({ ok: false, driver: 'smtp', id: null, category: 'brand_new_category', error: 'x' }).message).toBe('Sending failed. (x)');
  });
});

describe('email settings: status', () => {
  it('marks a configured provider as delivering', () => {
    expect(deliveryStatus(settings())).toEqual({ tone: 'good', label: 'delivering' });
    expect(statusNotes(settings())).toEqual([]);
  });

  it('flags a non-delivering driver and explains it once', () => {
    const log = settings({ driver: 'log', label: 'Log — development only', configured: false, from: null });
    expect(deliveryStatus(log)).toEqual({ tone: 'warn', label: 'not delivered · log driver' });
    expect(statusNotes(log)).toHaveLength(1);
    const withWarning = settings({ driver: 'log', configured: false, warnings: ['Log driver allowed in production by EMAIL_ALLOW_LOG_IN_PRODUCTION.'] });
    expect(statusNotes(withWarning)).toEqual(['Log driver allowed in production by EMAIL_ALLOW_LOG_IN_PRODUCTION.']);
  });

  it('shows any driver that does not deliver as not delivered', () => {
    expect(deliveryStatus(settings({ driver: 'smtp', configured: false }))).toEqual({ tone: 'warn', label: 'not delivered · smtp driver' });
  });
});
