import { describe, expect, it } from 'vitest';
import { ApiEnv, WorkerEnv, assertDriverConfig, loadEnv, parseQueueUrls } from '../src/index.js';

const base = {
  DATABASE_URL: 'postgres://u:supersecretpw@db:5432/ocso',
  BLOB_SIGNING_KEY: 'x'.repeat(32),
  OCSO_SECRETS_MASTER_KEY: 'a'.repeat(44),
};

describe('configuration', () => {
  it('applies safe defaults', () => {
    const env = loadEnv(ApiEnv, base);
    expect(env.QUEUE_DRIVER).toBe('postgres');
    expect(env.PORT).toBe(4000);
    expect(env.OCSO_ENABLE_DEV_PROVIDERS).toBe(false);
  });

  it('rejects invalid config without echoing secret values', () => {
    let message = '';
    try {
      loadEnv(WorkerEnv, { ...base, DATABASE_URL: 'not a url with secret-value-123' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('(value hidden)');
    expect(message).not.toContain('secret-value-123');
  });

  it('requires driver-specific settings', () => {
    expect(() => assertDriverConfig(loadEnv(ApiEnv, { ...base, QUEUE_DRIVER: 'sqs' }))).toThrow(/SQS_QUEUE_URLS/);
    expect(() => assertDriverConfig(loadEnv(ApiEnv, { ...base, BLOB_DRIVER: 's3' }))).toThrow(/S3_BUCKET/);
    expect(() => assertDriverConfig(loadEnv(ApiEnv, { DATABASE_URL: base.DATABASE_URL, BLOB_SIGNING_KEY: base.BLOB_SIGNING_KEY }))).toThrow(
      /OCSO_SECRETS_MASTER_KEY/,
    );
    expect(() => assertDriverConfig(loadEnv(ApiEnv, base))).not.toThrow();
  });

  it('refuses dev providers in production unless explicitly overridden', () => {
    const env = loadEnv(ApiEnv, { ...base, NODE_ENV: 'production', OCSO_ENABLE_DEV_PROVIDERS: 'true' });
    expect(() => assertDriverConfig(env)).toThrow(/OCSO_ENABLE_DEV_PROVIDERS/);
  });

  it('parses SQS topic URL pairs', () => {
    expect(parseQueueUrls('conversation.turn=https://sqs/a, channel.deliver=https://sqs/b')).toEqual({
      'conversation.turn': 'https://sqs/a',
      'channel.deliver': 'https://sqs/b',
    });
  });
});
