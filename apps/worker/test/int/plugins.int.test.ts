import 'reflect-metadata';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { ChannelRegistry } from '@ocso/channels';
import { createTestAuditDatabase, createTestDatabase, type TestAuditDatabase, type TestDatabase } from '@ocso/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkerInfrastructureModule } from '../../src/infrastructure/infrastructure.module.js';
import { CHANNEL_REGISTRY, PLUGINS } from '../../src/infrastructure/tokens.js';

// The worker's pino loggers write into `logLines` at info level (nothing reaches stdout).
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('pino', async (importOriginal) => {
  type Pino = typeof import('pino').pino;
  const actual = await importOriginal<Record<string, unknown> & { default: Pino }>();
  const pino = actual.default;
  const capture = { write: (line: string) => void logLines.push(line) };
  const wrapped = Object.assign((options: import('pino').LoggerOptions = {}) => pino({ ...options, level: 'info' }, capture), pino);
  return { ...actual, default: wrapped };
});

/** The worker loads the same installed plugins as the api (OCSO_PLUGINS), through its async PLUGINS provider. */
const NAME = 'ocso-channel-echo';
const SOURCE = `
export default {
  apiVersion: 1,
  name: '${NAME}',
  channels: [() => ({
    kind: 'ECHO',
    describe: () => ({ kind: 'ECHO', label: 'Echo', description: 'Test', mark: { code: 'EC', name: 'Echo' }, settingsSchema: {}, secrets: [], setupSteps: [], inboundWebhook: false, embeddable: false }),
    capabilities: () => ({}), validateConfig: () => [], verifyRequest: () => ({ kind: 'verified' }),
    parseInbound: () => ({ messages: [], statuses: [], ignored: 0 }), fetchMedia: async () => { throw new Error('none'); },
    render: () => [], send: async () => ({ ok: true, externalMessageId: 'e' }),
  })],
};
`;

let db: TestDatabase;
let auditDb: TestAuditDatabase;
let dir: string;
let app: INestApplicationContext;

beforeAll(async () => {
  db = await createTestDatabase();
  auditDb = await createTestAuditDatabase();
  dir = mkdtempSync(join(tmpdir(), 'ocso-worker-plugins-'));
  const root = join(dir, 'node_modules', NAME);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: NAME, version: '2.0.0', type: 'module', exports: './index.js' }));
  writeFileSync(join(root, 'index.js'), SOURCE);
  const keyFile = join(dir, 'audit_signing_key.pem');
  writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    AUDIT_DRIVER: 'postgres',
    AUDIT_DATABASE_URL: auditDb.url,
    AUDIT_SIGNING_KEY_FILE: keyFile,
    BLOB_SIGNING_KEY: 'test-blob-signing-key-0123456789',
    OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    BLOB_LOCAL_DIR: join(dir, 'blobs'),
    LOG_LEVEL: 'error',
    OCSO_PLUGINS: `${NAME}@2.0.0`,
    OCSO_PLUGINS_DIR: dir,
  });
  app = await NestFactory.createApplicationContext(WorkerInfrastructureModule, { logger: false, abortOnError: false });
});
afterAll(async () => {
  await app?.close();
  delete process.env['OCSO_PLUGINS'];
  delete process.env['OCSO_PLUGINS_DIR'];
  await db?.drop();
  await auditDb?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('worker plugins', () => {
  it('logs the loaded list with versions (the line the api logs too)', () => {
    const lines = logLines.map((line) => (JSON.parse(line) as { msg?: string }).msg ?? '').filter((msg) => msg.startsWith('plugins: '));
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^plugins: first-party @ocso/channels@.*; installed ${NAME}@2\\.0\\.0$`))]);
  });

  it('refuses to start when the installed version differs from the pin', async () => {
    process.env['OCSO_PLUGINS'] = `${NAME}@2.0.1`;
    try {
      await expect(NestFactory.createApplicationContext(WorkerInfrastructureModule, { logger: false, abortOnError: false })).rejects.toThrow(
        `${NAME}@2.0.1 is pinned, but 2.0.0 is installed in ${dir}`,
      );
    } finally {
      process.env['OCSO_PLUGINS'] = `${NAME}@2.0.0`;
    }
  });

  it('appends the installed plugins to the first-party ones and registers their kinds', () => {
    const plugins = app.get<Array<{ name: string; source?: string; version?: string }>>(PLUGINS);
    expect(plugins[0]?.name).toBe('@ocso/channels');
    expect(plugins.at(-1)).toMatchObject({ name: NAME, source: 'installed', version: '2.0.0' });
    expect(app.get<ChannelRegistry>(CHANNEL_REGISTRY).has('ECHO')).toBe(true);
  });
});
