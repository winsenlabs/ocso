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

  it('keeps the existing driver names and defaults, and leaves validation to the driver registries', () => {
    const env = loadEnv(WorkerEnv, base);
    expect(env).toMatchObject({ QUEUE_DRIVER: 'postgres', BLOB_DRIVER: 'local', SECRETS_DRIVER: 'local', DEPLOYMENT_DRIVER: 'compose' });
    // Any name parses (a plugin may register it); @ocso/bootstrap's assertDrivers rejects unregistered ones.
    const custom = loadEnv(WorkerEnv, { ...base, QUEUE_DRIVER: 'sqs', BLOB_DRIVER: ' gcs ', SECRETS_DRIVER: 'vault', DEPLOYMENT_DRIVER: 'nomad' });
    expect(custom).toMatchObject({ QUEUE_DRIVER: 'sqs', BLOB_DRIVER: 'gcs', SECRETS_DRIVER: 'vault', DEPLOYMENT_DRIVER: 'nomad' });
    expect(() => loadEnv(ApiEnv, { ...base, BLOB_DRIVER: '' })).toThrow(/BLOB_DRIVER/);
    expect(() => assertDriverConfig(custom)).not.toThrow();
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
