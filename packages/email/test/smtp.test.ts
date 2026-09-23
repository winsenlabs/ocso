import { describe, expect, it } from 'vitest';
import { EmailSendError, SmtpEmailSender, classifySmtpError, stableMessageId, type SmtpTransportOptions } from '../src/index.js';
import { fakeTransport, smtpError } from './helpers.js';

const SMTP: SmtpTransportOptions = { host: 'smtp.meridian.test', port: 587, secure: false, requireTLS: true, auth: { user: 'apikey', pass: 'hunter2hunter2' }, timeoutMs: 5000 };
const FROM = '"Meridian Bank, Support" <support@meridian.test>';

describe('SmtpEmailSender', () => {
  it('sends through one lazily created transport with reply-to, stable Message-ID and kind header', async () => {
    const t = fakeTransport();
    const sender = new SmtpEmailSender({ from: FROM, replyTo: 'help@meridian.test', smtp: SMTP, transportFactory: t.factory });
    expect(t.options).toHaveLength(0);
    const result = await sender.send({ to: 'tarun@meridian.test', subject: 'Reset\nnow', html: '<p>x</p>', text: 'x', tags: { kind: 'password_reset' }, idempotencyKey: 'reset/1' });
    await sender.send({ to: ['a@meridian.test', 'b@meridian.test'], subject: 's', html: 'h', text: 't', replyTo: 'lead@meridian.test' });
    expect(result).toEqual({ id: '<m1@test>' });
    expect(t.options).toEqual([SMTP]);
    expect(t.sent[0]).toEqual({
      from: FROM,
      to: ['tarun@meridian.test'],
      subject: 'Reset now',
      html: '<p>x</p>',
      text: 'x',
      headers: { 'X-OCSO-Email-Kind': 'password_reset' },
      replyTo: 'help@meridian.test',
      messageId: stableMessageId('reset/1', FROM),
    });
    expect(t.sent[0]!.messageId).toMatch(/^<[0-9a-f]{32}@meridian\.test>$/);
    expect(t.sent[1]).toMatchObject({ to: ['a@meridian.test', 'b@meridian.test'], replyTo: 'lead@meridian.test', messageId: undefined, headers: {} });
    expect(sender.driver).toBe('smtp');
  });

  it('maps SMTP failures to EmailSendError without server text and reconnects on the next send', async () => {
    const cases: Array<[Error, boolean, number | null, string]> = [
      [smtpError('EAUTH', 535), false, 535, 'auth'],
      [smtpError('EENVELOPE', 550), false, 550, 'validation'],
      [smtpError('EMESSAGE', 451), true, 451, 'unavailable'],
      [smtpError('ECONNECTION'), true, null, 'network'],
      [smtpError('ETLS'), false, null, 'auth'],
    ];
    for (const [error, retriable, status, category] of cases) {
      let fail = true;
      const t = fakeTransport(async () => {
        if (fail) throw error;
        return { messageId: '<ok@test>' };
      });
      const sender = new SmtpEmailSender({ from: FROM, smtp: SMTP, transportFactory: t.factory });
      const e = (await sender.send({ to: 'x@meridian.test', subject: 's', html: 'h', text: 't' }).catch((x: unknown) => x)) as EmailSendError;
      expect(e).toBeInstanceOf(EmailSendError);
      expect({ retriable: e.retriable, status: e.status, category: e.category }).toEqual({ retriable, status, category });
      expect(e.message).not.toContain('hunter2');
      expect(e.message).not.toContain('alerts@meridian.test');
      expect(t.closed()).toBe(1);
      fail = false;
      await sender.send({ to: 'x@meridian.test', subject: 's', html: 'h', text: 't' });
      expect(t.options).toHaveLength(2);
    }
    expect(classifySmtpError(new Error('boom'))).toEqual({ retriable: true, error: 'SMTP UNKNOWN', status: null, category: 'unknown' });
  });

  it('refuses a message without recipients', async () => {
    const t = fakeTransport();
    const sender = new SmtpEmailSender({ from: FROM, smtp: SMTP, transportFactory: t.factory });
    await expect(sender.send({ to: [], subject: 's', html: 'h', text: 't' })).rejects.toMatchObject({ retriable: false, category: 'validation' });
    expect(t.sent).toHaveLength(0);
  });
});
