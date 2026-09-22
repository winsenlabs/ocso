import { describe, expect, it } from 'vitest';
import { classifySmtpError, createEmailAdapter, type EmailConfig } from '../src/index.js';
import { fakeTransport, message } from './helpers.js';

const PASSWORD = 'smtp-app-password-123';

function config(overrides: Record<string, unknown> = {}): EmailConfig {
  const check = createEmailAdapter({ mailTransport: fakeTransport().factory }).validateConfig({
    host: 'smtp.meridian.test',
    from: 'alerts@meridian.test',
    to: ['oncall@meridian.test', 'lead@meridian.test'],
    ...overrides,
  });
  if (!check.ok) throw new Error(check.problems.join('; '));
  return check.config;
}

const smtpError = (code: string, responseCode?: number) => Object.assign(new Error(`${code} failed for user alerts@meridian.test with ${PASSWORD}`), { code, responseCode });

describe('Email adapter (SMTP)', () => {
  it('normalizes config: port 587 + STARTTLS by default, implicit TLS on 465', () => {
    expect(config()).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(config({ port: 465 })).toMatchObject({ port: 465, secure: true });
    const adapter = createEmailAdapter({ mailTransport: fakeTransport().factory });
    expect(adapter.validateConfig({ host: 'x', from: 'alerts@meridian.test', to: [] }).ok).toBe(false);
    expect(adapter.validateConfig({ host: 'x', from: 'not-an-email', to: ['a@b.test'] }).ok).toBe(false);
  });

  it('sends one message with subject, text and escaped HTML, then closes the transport', async () => {
    const t = fakeTransport();
    const adapter = createEmailAdapter({ mailTransport: t.factory, timeoutMs: 5000 });
    const result = await adapter.deliver(message({ body: 'Error rate <script>x</script>' }), config(), PASSWORD);
    expect(result).toEqual({ ok: true, retriable: false, externalId: '<m1@test>' });
    expect(t.options[0]).toEqual({
      host: 'smtp.meridian.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'alerts@meridian.test', pass: PASSWORD },
      timeoutMs: 5000,
    });
    const mail = t.sent[0]!;
    expect(mail.to).toEqual(['oncall@meridian.test', 'lead@meridian.test']);
    expect(mail.subject).toBe('[OCSO CRITICAL] Provider error rate above 5% · AWS Bedrock');
    expect(mail.text).toContain('Severity: Critical');
    expect(mail.text).toContain(`Open in OCSO: ${message().link}`);
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.headers['X-OCSO-Alert-Event']).toBe('OPENED');
    expect(t.closed()).toBe(1);
  });

  it('uses the configured username and omits auth without a secret', async () => {
    const t = fakeTransport();
    const adapter = createEmailAdapter({ mailTransport: t.factory });
    await adapter.deliver(message(), config({ username: 'apikey' }), PASSWORD);
    await adapter.deliver(message(), config(), null);
    expect(t.options[0]!.auth).toEqual({ user: 'apikey', pass: PASSWORD });
    expect(t.options[1]!.auth).toBeUndefined();
  });

  it('classifies SMTP failures without echoing server text or the password', async () => {
    const cases: Array<[Error, boolean, string]> = [
      [smtpError('EAUTH', 535), false, 'SMTP EAUTH (535)'],
      [smtpError('EENVELOPE', 550), false, 'SMTP EENVELOPE (550)'],
      [smtpError('EMESSAGE', 451), true, 'SMTP EMESSAGE (451)'],
      [smtpError('ECONNECTION'), true, 'SMTP ECONNECTION'],
      [smtpError('ETIMEDOUT'), true, 'SMTP ETIMEDOUT'],
      [smtpError('ETLS'), false, 'SMTP ETLS'],
    ];
    for (const [error, retriable, label] of cases) {
      const t = fakeTransport(async () => {
        throw error;
      });
      const result = await createEmailAdapter({ mailTransport: t.factory }).deliver(message(), config(), PASSWORD);
      expect(result).toEqual({ ok: false, retriable, error: label });
      expect(t.closed()).toBe(1);
    }
    expect(classifySmtpError(new Error('boom'))).toEqual({ retriable: true, error: 'SMTP UNKNOWN' });
  });
});
