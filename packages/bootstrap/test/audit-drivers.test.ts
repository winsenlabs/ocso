import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClickHouseAuditStore, PostgresAuditStore, generateSigningKeyPem, loadSigningKey, type AuditStore, type AuditStoreDriverDefinition } from '@ocso/audit-store';
import { ApiEnv, WorkerEnv, loadEnv } from '@ocso/config';
import { afterAll, describe, expect, it } from 'vitest';
import { FIRST_PARTY_PLUGINS, assertDrivers, assertWorkerDrivers, createAuditStore, createDriverRegistries, loadAuditSigner, type DriverEnv } from '../src/index.js';

const base = { DATABASE_URL: 'postgres://u:pw@db:5432/ocso', BLOB_SIGNING_KEY: 'x'.repeat(32), OCSO_SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') };
const quiet = { info: () => {}, warn: () => {} };
const dir = mkdtempSync(join(tmpdir(), 'ocso-audit-driver-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('audit store driver selection (AUDIT_DRIVER, ADR-032)', () => {
  it('defaults to the postgres driver, which needs a writer URL (inline or as a file)', async () => {
    const drivers = createDriverRegistries();
    expect(() => assertDrivers(loadEnv(ApiEnv, base), drivers)).toThrow(/AUDIT_DRIVER=postgres requires AUDIT_DATABASE_URL/);
    const env = loadEnv(ApiEnv, { ...base, AUDIT_DATABASE_URL: 'postgres://w:pw@audit:5432/a' });
    expect(() => assertDrivers(env, drivers)).not.toThrow();
    const store = createAuditStore(env, quiet, drivers);
    expect(store).toBeInstanceOf(PostgresAuditStore);
    expect(store.driver).toBe('postgres');
    await store.close();
    const file = join(dir, 'audit_database_url');
    writeFileSync(file, 'postgres://w:pw@audit:5432/a\n');
    const fromFile = createAuditStore(loadEnv(ApiEnv, { ...base, AUDIT_DATABASE_URL_FILE: file }), quiet, drivers);
    expect(fromFile.driver).toBe('postgres');
    await fromFile.close();
  });

  it('selects clickhouse by name and checks its settings', () => {
    const drivers = createDriverRegistries();
    const missing = loadEnv(WorkerEnv, { ...base, AUDIT_DRIVER: 'clickhouse' });
    expect(() => assertWorkerDrivers(missing, drivers)).toThrow(/AUDIT_DRIVER=clickhouse requires CLICKHOUSE_URL[\s\S]*CLICKHOUSE_USER/);
    const env = loadEnv(WorkerEnv, { ...base, AUDIT_DRIVER: 'clickhouse', CLICKHOUSE_URL: 'http://clickhouse:8123', CLICKHOUSE_USER: 'ocso_audit_writer', CLICKHOUSE_PASSWORD: 'pw' });
    expect(() => assertWorkerDrivers(env, drivers)).not.toThrow();
    expect(createAuditStore(env, quiet, drivers)).toBeInstanceOf(ClickHouseAuditStore);
  });

  it('refuses an unregistered driver, and production without a signing key', () => {
    const drivers = createDriverRegistries();
    expect(() => assertDrivers(loadEnv(ApiEnv, { ...base, AUDIT_DRIVER: 'bigquery' }), drivers)).toThrow(
      /AUDIT_DRIVER=bigquery is not available; registered audit store drivers: postgres, clickhouse/,
    );
    const prod = loadEnv(ApiEnv, { ...base, NODE_ENV: 'production', AUDIT_DATABASE_URL: 'postgres://w:pw@a/a', BETTER_AUTH_SECRET: 's'.repeat(40) });
    expect(() => assertDrivers(prod, drivers)).toThrow(/AUDIT_SIGNING_KEY_FILE .* is required in production/);
  });

  it('loads the signing key from its file; outside production a missing file means one shared development key', () => {
    const pem = generateSigningKeyPem();
    const file = join(dir, 'audit_signing_key');
    writeFileSync(file, pem);
    expect(loadAuditSigner({ NODE_ENV: 'production', AUDIT_SIGNING_KEY_FILE: file }, quiet).keyId).toBe(loadSigningKey(pem).keyId);
    const warnings: string[] = [];
    const devKey = join(dir, 'dev', '.ocso', 'audit_signing_key.pem');
    const api = loadAuditSigner({ NODE_ENV: 'development', AUDIT_SIGNING_KEY_FILE: undefined }, { warn: (m) => warnings.push(m) }, devKey);
    // The worker (another process, same workspace) signs with the same key, so the api verifies its checkpoints.
    const worker = loadAuditSigner({ NODE_ENV: 'development', AUDIT_SIGNING_KEY_FILE: undefined }, quiet, devKey);
    expect(worker.keyId).toBe(api.keyId);
    expect(warnings[0]).toMatch(/development key/);
    expect(() => loadAuditSigner({ NODE_ENV: 'production', AUDIT_SIGNING_KEY_FILE: undefined }, quiet)).toThrow(/required in production/);
  });

  it('trusts retired public keys from AUDIT_TRUSTED_PUBLIC_KEYS_FILE (key rotation)', () => {
    const current = generateSigningKeyPem();
    const retired = [loadSigningKey(generateSigningKeyPem()), loadSigningKey(generateSigningKeyPem())];
    const bundle = join(dir, 'trusted_public_keys.pem');
    writeFileSync(bundle, `${retired.map((k) => k.publicKeyPem).join('\n')}\n${loadSigningKey(current).publicKeyPem}`);
    const signer = loadAuditSigner({ NODE_ENV: 'production', AUDIT_SIGNING_KEY: current, AUDIT_SIGNING_KEY_FILE: undefined, AUDIT_TRUSTED_PUBLIC_KEYS_FILE: bundle }, quiet);
    expect(signer.keyId).toBe(loadSigningKey(current).keyId);
    expect(signer.retiredKeys!.map((k) => k.keyId)).toEqual(retired.map((k) => k.keyId));
  });

  it('selects an audit store driver another plugin contributes, exactly like a first-party one', () => {
    const memory: AuditStoreDriverDefinition<DriverEnv, never> = { name: 'memory', create: () => ({ driver: 'memory' }) as unknown as AuditStore };
    const drivers = createDriverRegistries([...FIRST_PARTY_PLUGINS, { name: 'acme-audit', auditStoreDrivers: [memory] }]);
    expect(drivers.audit.names()).toEqual(['postgres', 'clickhouse', 'memory']);
    expect(createAuditStore(loadEnv(ApiEnv, { ...base, AUDIT_DRIVER: 'memory' }), quiet, drivers).driver).toBe('memory');
  });
});
