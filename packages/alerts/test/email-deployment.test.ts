import { EmailSendError, LogEmailSender, type EmailMessage, type EmailSender } from '@ocso/email';
import { describe, expect, it } from 'vitest';
import { createDefaultDeliveryRegistry, createEmailAdapter, secretRequirement, type EmailConfig } from '../src/index.js';
import { fakeFetch, fakeTransport, message } from './helpers.js';

/** Records sends; `fail` makes the next send throw. */
function fakeSender(fail?: EmailSendError | Error) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    driver: 'resend',
    from: 'OCSO Alerts <alerts@mail.meridian.test>',
    async send(m) {
      if (fail) throw fail;
      sent.push(m);
      return { id: 'resend-id-1' };
    },
  };
  return { sender, sent };
}

function validate(config: unknown, emailSender: EmailSender | null = null): EmailConfig {
  const check = createEmailAdapter({ mailTransport: fakeTransport().factory, emailSender }).validateConfig(config);
  if (!check.ok) throw new Error(check.problems.join('; '));
  return check.config;
}

describe('Email adapter · deployment sender', () => {
  it('defaults new destinations to the deployment sender and keeps legacy SMTP configs on SMTP', () => {
    expect(validate({ to: ['oncall@meridian.test'] })).toEqual({ transport: 'deployment', to: ['oncall@meridian.test'] });
    expect(validate({ host: 'smtp.meridian.test', from: 'alerts@meridian.test', to: ['a@meridian.test'] })).toMatchObject({ transport: 'smtp', port: 587, secure: false });
    const adapter = createEmailAdapter({ mailTransport: fakeTransport().factory });
    expect(adapter.validateConfig({ transport: 'deployment', to: ['a@meridian.test'], host: 'x' }).ok).toBe(false);
    expect(adapter.validateConfig({ transport: 'deployment', to: [] }).ok).toBe(false);
    expect(adapter.validateConfig({ transport: 'smtp', to: ['a@meridian.test'] }).ok).toBe(false);
    expect(adapter.validateConfig({ transport: 'carrier-pigeon', to: ['a@meridian.test'] }).ok).toBe(false);
  });

  it('takes an SMTP password only for the SMTP transport', () => {
    const adapter = createEmailAdapter({ mailTransport: fakeTransport().factory });
    expect(secretRequirement(adapter, validate({ to: ['a@meridian.test'] }))).toBeNull();
    expect(secretRequirement(adapter, validate({ host: 'h.test', from: 'a@meridian.test', to: ['a@meridian.test'] }))).toMatchObject({ required: false });
  });

  it('sends the rendered alert through the deployment sender, idempotent per delivery', async () => {
    const { sender, sent } = fakeSender();
    const t = fakeTransport();
    const adapter = createEmailAdapter({ mailTransport: t.factory, emailSender: sender });
    const msg = message({ body: 'Error rate <script>x</script>' });
    const result = await adapter.deliver(msg, validate({ to: ['oncall@meridian.test', 'lead@meridian.test'] }), 'ignored-secret');
    expect(result).toEqual({ ok: true, retriable: false, externalId: 'resend-id-1' });
    expect(t.options).toHaveLength(0);
    const mail = sent[0]!;
    expect(mail.to).toEqual(['oncall@meridian.test', 'lead@meridian.test']);
    expect(mail.subject).toBe('[OCSO CRITICAL] Provider error rate above 5% · AWS Bedrock');
    expect(mail.idempotencyKey).toBe(`alert-delivery/${msg.deliveryId}`);
    expect(mail.tags).toEqual({ kind: 'alert', event: 'OPENED', severity: 'CRITICAL' });
    expect(mail.text).toContain('Severity: Critical');
    expect(mail.text).toContain(`Open in OCSO: ${msg.link}`);
    expect(mail.text).toContain('Sent by OCSO for Meridian Bank · PROD.');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.replyTo).toBeUndefined();
  });

  it('maps sender errors to delivery results (retriable flag preserved) and fails without a sender', async () => {
    const config = validate({ to: ['oncall@meridian.test'] });
    const cases: Array<[Error, boolean, string]> = [
      [new EmailSendError('Resend HTTP 429 (rate_limit_exceeded)', true, 429, 'rate_limited'), true, 'Resend HTTP 429 (rate_limit_exceeded)'],
      [new EmailSendError('Resend HTTP 403 (validation_error: The domain is not verified)', false, 403, 'auth'), false, 'Resend HTTP 403 (validation_error: The domain is not verified)'],
      [new Error('socket hang up with secrets'), true, 'email send failed'],
    ];
    for (const [error, retriable, text] of cases) {
      const adapter = createEmailAdapter({ mailTransport: fakeTransport().factory, emailSender: fakeSender(error).sender });
      expect(await adapter.deliver(message(), config, null)).toEqual({ ok: false, retriable, error: text });
    }
    const orphan = createEmailAdapter({ mailTransport: fakeTransport().factory });
    expect(await orphan.deliver(message(), config, null)).toEqual({ ok: false, retriable: false, error: 'deployment email sender is not available' });
  });

  it('is wired through the default registry (log driver in development)', async () => {
    const log = new LogEmailSender('OCSO <no-reply@ocso.invalid>');
    const registry = createDefaultDeliveryRegistry({ fetch: fakeFetch().fetch, mailTransport: fakeTransport().factory, emailSender: log });
    const email = registry.get('EMAIL');
    expect(email.label).toBe('Email');
    const check = email.validateConfig({ to: ['oncall@meridian.test'] });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(await email.deliver(message(), check.config, null)).toEqual({ ok: true, retriable: false });
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.to).toEqual(['oncall@meridian.test']);
  });
});
