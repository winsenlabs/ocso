import { describe, expect, it } from 'vitest';
import { ApiEnv, WorkerEnv, loadEnv } from '../src/index.js';

const base = {
  DATABASE_URL: 'postgres://u:supersecretpw@db:5432/ocso',
  BLOB_SIGNING_KEY: 'x'.repeat(32),
  OCSO_SECRETS_MASTER_KEY: 'a'.repeat(44),
};

describe('email configuration (bootstrap env)', () => {
  it('parses EMAIL_* / RESEND_* / SMTP_* for api and worker; Compose blanks mean unset', () => {
    for (const schema of [ApiEnv, WorkerEnv]) {
      const blanks = loadEnv(schema, { ...base, EMAIL_DRIVER: '', EMAIL_FROM: '', RESEND_API_KEY: '', SMTP_PORT: '', SMTP_SECURE: '', EMAIL_ALLOW_LOG_IN_PRODUCTION: '' });
      expect(blanks).toMatchObject({ EMAIL_DRIVER: undefined, EMAIL_FROM: undefined, RESEND_API_KEY: undefined, SMTP_PORT: undefined, SMTP_SECURE: undefined });
      const env = loadEnv(schema, {
        ...base,
        EMAIL_DRIVER: 'smtp',
        EMAIL_FROM: 'OCSO <ocso@meridian.test>',
        SMTP_HOST: 'smtp.meridian.test',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_REQUIRE_TLS: 'false',
        EMAIL_ALLOW_LOG_IN_PRODUCTION: '1',
      });
      expect(env).toMatchObject({ EMAIL_DRIVER: 'smtp', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_REQUIRE_TLS: false, EMAIL_ALLOW_LOG_IN_PRODUCTION: true });
    }
    expect(() => loadEnv(ApiEnv, { ...base, EMAIL_DRIVER: 'sendgrid' })).toThrow(/EMAIL_DRIVER/);
  });

  it('hides RESEND_API_KEY and SMTP_URL values in configuration errors', () => {
    let message = '';
    try {
      loadEnv(ApiEnv, { ...base, RESEND_API_KEY: 'k'.repeat(600), SMTP_URL: `smtp://u:${'p'.repeat(3000)}@h` });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/RESEND_API_KEY: .*\(value hidden\)/);
    expect(message).toMatch(/SMTP_URL: .*\(value hidden\)/);
    expect(message).not.toContain('kkkk');
  });
});
