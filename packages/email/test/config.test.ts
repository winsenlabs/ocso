import { describe, expect, it } from 'vitest';
import {
  EmailConfigError,
  LOG_DRIVER_FROM,
  LogEmailSender,
  ResendEmailSender,
  SmtpEmailSender,
  createEmailSender,
  emailStatus,
  formatMailbox,
  normalizeMailbox,
  parseMailbox,
  resolveEmailConfig,
  type EmailEnv,
} from '../src/index.js';
import { API_KEY, fakeFetch, fakeTransport } from './helpers.js';

const problems = (env: EmailEnv, readFile?: (p: string) => string): string[] => {
  try {
    resolveEmailConfig(env, { readFile });
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(EmailConfigError);
    return [...(error as EmailConfigError).problems];
  }
};
const RESEND: EmailEnv = { NODE_ENV: 'production', EMAIL_DRIVER: 'resend', EMAIL_FROM: 'Meridian <support@mail.meridian.test>', RESEND_API_KEY: API_KEY };

describe('createEmailSender (EMAIL_DRIVER selection)', () => {
  it('defaults to the log driver in development and test', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      const sender = createEmailSender({ NODE_ENV });
      expect(sender).toBeInstanceOf(LogEmailSender);
      expect(sender.from).toBe(LOG_DRIVER_FROM);
    }
    expect(emailStatus(resolveEmailConfig({ NODE_ENV: 'test' }))).toEqual({ driver: 'log', from: null, replyTo: null, configured: false, warnings: [] });
  });

  it('production requires an explicit driver and refuses log unless explicitly allowed', () => {
    expect(problems({ NODE_ENV: 'production' })[0]).toMatch(/EMAIL_DRIVER is required in production/);
    expect(problems({ NODE_ENV: 'production', EMAIL_DRIVER: 'log' })[0]).toMatch(/EMAIL_DRIVER=log delivers no email.*EMAIL_ALLOW_LOG_IN_PRODUCTION=true/);
    const allowed = resolveEmailConfig({ NODE_ENV: 'production', EMAIL_ALLOW_LOG_IN_PRODUCTION: true });
    expect(allowed.driver).toBe('log');
    expect(emailStatus(allowed)).toMatchObject({ configured: false, warnings: [expect.stringMatching(/Log driver in production/)] });
    expect(() => createEmailSender({ NODE_ENV: 'production' })).toThrow(/Invalid OCSO configuration:\n {2}- EMAIL_DRIVER is required/);
  });

  it('builds the Resend sender (key from env or file) and reports a secret-free status', async () => {
    const f = fakeFetch();
    const sender = createEmailSender({ ...RESEND, EMAIL_REPLY_TO: 'help@meridian.test' }, { fetch: f.fetch, resendBaseUrl: 'https://resend.fake' });
    expect(sender).toBeInstanceOf(ResendEmailSender);
    await sender.send({ to: 'a@meridian.test', subject: 's', html: 'h', text: 't' });
    expect(f.calls[0]).toMatchObject({ url: 'https://resend.fake/emails', body: { from: 'Meridian <support@mail.meridian.test>', reply_to: 'help@meridian.test' } });

    const fromFile = resolveEmailConfig({ ...RESEND, RESEND_API_KEY: undefined, RESEND_API_KEY_FILE: '/run/secrets/resend' }, { readFile: () => `${API_KEY}\n` });
    expect(fromFile.resend).toEqual({ apiKey: API_KEY });
    const status = emailStatus(fromFile);
    expect(status).toEqual({ driver: 'resend', from: 'Meridian <support@mail.meridian.test>', replyTo: null, configured: true, warnings: [] });
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  });

  it('lists every Resend problem without echoing values', () => {
    expect(problems({ ...RESEND, RESEND_API_KEY: undefined })).toEqual(['EMAIL_DRIVER=resend requires RESEND_API_KEY or RESEND_API_KEY_FILE']);
    expect(problems({ ...RESEND, EMAIL_FROM: undefined })).toEqual([expect.stringMatching(/requires EMAIL_FROM/)]);
    const bad = problems({ ...RESEND, EMAIL_FROM: 'not an address', EMAIL_REPLY_TO: 'x@', RESEND_API_KEY: undefined, RESEND_API_KEY_FILE: '/missing' }, () => {
      throw new Error('ENOENT /missing');
    });
    expect(bad).toEqual([
      expect.stringMatching(/^EMAIL_FROM must be an email address/),
      expect.stringMatching(/^EMAIL_REPLY_TO must be an email address/),
      'RESEND_API_KEY_FILE points to a missing or unreadable file',
    ]);
    expect(problems({ ...RESEND, RESEND_API_KEY: undefined, RESEND_API_KEY_FILE: '/empty' }, () => '  \n')).toEqual(['RESEND_API_KEY_FILE points to an empty file']);
    const withKey = problems({ ...RESEND, EMAIL_FROM: 'bad' });
    expect(withKey.join('\n')).not.toContain(API_KEY);
  });

  it('builds the SMTP sender from discrete settings or SMTP_URL, password from a file', async () => {
    const t = fakeTransport();
    const smtp = { NODE_ENV: 'production', EMAIL_DRIVER: 'smtp', EMAIL_FROM: 'OCSO <ocso@meridian.test>' } as const;
    const sender = createEmailSender({ ...smtp, SMTP_HOST: 'smtp.meridian.test', SMTP_USER: 'apikey', SMTP_PASSWORD_FILE: '/run/secrets/smtp' }, { transportFactory: t.factory, readFile: () => 'pw-from-file\n' });
    expect(sender).toBeInstanceOf(SmtpEmailSender);
    await sender.send({ to: 'a@meridian.test', subject: 's', html: 'h', text: 't' });
    expect(t.options[0]).toEqual({ host: 'smtp.meridian.test', port: 587, secure: false, requireTLS: true, auth: { user: 'apikey', pass: 'pw-from-file' }, timeoutMs: 10_000 });

    const url = resolveEmailConfig({ ...smtp, SMTP_URL: 'smtps://mailer%40meridian.test:p%40ss@smtp.meridian.test' });
    expect(url.smtp).toMatchObject({ host: 'smtp.meridian.test', port: 465, secure: true, auth: { user: 'mailer@meridian.test', pass: 'p@ss' } });
    const relay = resolveEmailConfig({ ...smtp, SMTP_HOST: 'mailpit', SMTP_PORT: 1025, SMTP_REQUIRE_TLS: false });
    expect(relay.smtp).toEqual({ host: 'mailpit', port: 1025, secure: false, requireTLS: false, auth: undefined, timeoutMs: 10_000 });
    // Password without SMTP_USER: the from address is the user name.
    expect(resolveEmailConfig({ ...smtp, SMTP_HOST: 'h.test', SMTP_PASSWORD: 'pw' }).smtp?.auth).toEqual({ user: 'ocso@meridian.test', pass: 'pw' });
    expect(problems({ ...smtp })).toEqual(['EMAIL_DRIVER=smtp requires SMTP_HOST or SMTP_URL']);
    const badUrl = problems({ ...smtp, SMTP_URL: 'http://user:secretpw@host' });
    expect(badUrl).toEqual(['SMTP_URL must use the smtp:// or smtps:// scheme']);
  });
});

describe('mailboxes', () => {
  it('parses, validates and re-quotes display names', () => {
    expect(parseMailbox('support@meridian.test')).toEqual({ name: null, address: 'support@meridian.test' });
    expect(parseMailbox('  Meridian Support <support@meridian.test> ')).toEqual({ name: 'Meridian Support', address: 'support@meridian.test' });
    expect(normalizeMailbox('"Meridian Bank, Support" <support@meridian.test>', 'EMAIL_FROM')).toBe('"Meridian Bank, Support" <support@meridian.test>');
    expect(normalizeMailbox('Meridian Bank, Support <support@meridian.test>', 'EMAIL_FROM')).toBe('"Meridian Bank, Support" <support@meridian.test>');
    expect(formatMailbox({ name: 'Say "hi"', address: 'a@b.test' })).toBe('"Say \\"hi\\"" <a@b.test>');
    for (const bad of ['', 'nobody', 'a@b', 'a@@b.test', 'a b@c.test', 'x <a@b.test>\r\nBcc: y@z.test', 'a@b.test, c@d.test', '<a@b.test> x', '.a@b.test']) {
      expect(parseMailbox(bad), bad).toBeNull();
    }
    expect(() => normalizeMailbox('bad', 'EMAIL_REPLY_TO')).toThrow(/^EMAIL_REPLY_TO must be an email address/);
  });
});
