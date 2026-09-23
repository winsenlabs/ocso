import { describe, expect, it } from 'vitest';
import { ApiEnv, AuditToolsEnv, WorkerEnv, loadEnv } from '../src/index.js';

const base = { DATABASE_URL: 'postgres://u:pw@db:5432/ocso' };

describe('audit store settings (ADR-032)', () => {
  it('default to the postgres driver with a small pool, in the api and the worker alike', () => {
    for (const schema of [ApiEnv, WorkerEnv]) {
      expect(loadEnv(schema, base)).toMatchObject({ AUDIT_DRIVER: 'postgres', AUDIT_DATABASE_POOL_SIZE: 5, CLICKHOUSE_DATABASE: 'ocso_audit' });
    }
    // Compose passes unset settings as empty strings.
    expect(loadEnv(ApiEnv, { ...base, AUDIT_DATABASE_URL: '', CLICKHOUSE_URL: '', AUDIT_SIGNING_KEY_FILE: '' }).AUDIT_DATABASE_URL).toBeUndefined();
  });

  it('never echoes audit credentials in configuration errors', () => {
    const secret = 'sup3r-s3cret-owner-pw';
    const bad = { ...base, AUDIT_DATABASE_URL: `not a url ${secret}`, CLICKHOUSE_URL: `nope ${secret}`, AUDIT_DATABASE_POOL_SIZE: '0' };
    let message = '';
    try {
      loadEnv(ApiEnv, bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/AUDIT_DATABASE_URL: .*\(value hidden\)/);
    expect(message).toMatch(/CLICKHOUSE_URL: .*\(value hidden\)/);
    expect(message).not.toContain(secret);
    let tools = '';
    try {
      loadEnv(AuditToolsEnv, { AUDIT_DATABASE_OWNER_URL: `x ${secret}` });
    } catch (e) {
      tools = (e as Error).message;
    }
    expect(tools).toMatch(/AUDIT_DATABASE_OWNER_URL: .*\(value hidden\)/);
    expect(tools).not.toContain(secret);
  });

  it('gives the provisioning tools owner settings the api and worker never parse', () => {
    const env = loadEnv(AuditToolsEnv, { AUDIT_DATABASE_OWNER_URL: 'postgres://o:pw@audit:5432/a', AUDIT_PROVISION_ROLE: 'false', CLICKHOUSE_ADMIN_USER: 'admin' });
    expect(env).toMatchObject({ AUDIT_DRIVER: 'postgres', AUDIT_PROVISION_ROLE: false, CLICKHOUSE_ADMIN_USER: 'admin' });
    expect(loadEnv(AuditToolsEnv, {}).AUDIT_PROVISION_ROLE).toBe(true);
    expect('AUDIT_DATABASE_OWNER_URL' in loadEnv(ApiEnv, { ...base, AUDIT_DATABASE_OWNER_URL: 'postgres://o:pw@a/a' })).toBe(false);
  });
});
