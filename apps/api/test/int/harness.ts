import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestAuditDatabase, createTestDatabase, type TestAuditDatabase, type TestDatabase } from '@ocso/db/testing';
import type { LogEmailSender } from '@ocso/email';
import { EMAIL_SENDER } from '../../src/infrastructure/tokens.js';

export interface ApiHarness {
  app: INestApplication;
  db: TestDatabase;
  /** The audit store database (ADR-032): writer URL, owner URL for tamper tests. */
  auditDb: TestAuditDatabase;
  http: () => ReturnType<typeof request>;
  /** Better Auth email + password sign-in (POST /api/auth/sign-in/email); returns the bearer token. */
  loginAs(email: string, password: string): Promise<string>;
  /** Emails the log driver captured for an address (newest last). */
  emailsTo(email: string): Array<{ subject: string; text: string; kind: string | null }>;
  /** The token from the newest /invite or /reset-password link emailed to an address. */
  linkToken(email: string, page: '/invite' | '/reset-password'): string;
  close(): Promise<void>;
}

export const SETUP_TOKEN = 'integration-setup-token-1';
export const ADMIN = { email: 'admin@ocso.test', password: 'admin password 1234' };

/**
 * Boot the real AppModule against a fresh migrated database. Access approval is
 * skipped (OCSO_DEV_SKIP_ACCESS_APPROVAL) so suites can create working users;
 * `{ env: { OCSO_DEV_SKIP_ACCESS_APPROVAL: 'false' } }` runs the governed path.
 */
export async function startApi(options: { env?: Record<string, string> } = {}): Promise<ApiHarness> {
  const db = await createTestDatabase();
  const auditDb = await createTestAuditDatabase();
  const keyDir = mkdtempSync(join(tmpdir(), 'ocso-test-audit-key-'));
  const auditKeyFile = join(keyDir, 'audit_signing_key.pem');
  writeFileSync(auditKeyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUDIT_DRIVER: 'postgres',
    AUDIT_DATABASE_URL: auditDb.url,
    AUDIT_SIGNING_KEY_FILE: auditKeyFile,
    DATABASE_URL: db.url,
    BLOB_SIGNING_KEY: 'test-blob-signing-key-0123456789',
    OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    OCSO_SETUP_TOKEN: SETUP_TOKEN,
    BLOB_LOCAL_DIR: `/tmp/ocso-test-blobs-${db.name}`,
    LOG_LEVEL: 'error',
    OCSO_DEV_SKIP_ACCESS_APPROVAL: 'true',
    ...options.env,
  });
  const { createApp } = await import('../../src/bootstrap.js');
  const app = await createApp({ logger: false });
  await app.init();
  const http = () => request(app.getHttpServer());
  const emailsTo = (email: string) =>
    app
      .get<LogEmailSender>(EMAIL_SENDER)
      .sent.filter((m) => [m.to].flat().some((to) => to.toLowerCase() === email.toLowerCase()))
      .map((m) => ({ subject: m.subject, text: m.text, kind: m.tags?.['kind'] ?? null }));
  return {
    app,
    db,
    auditDb,
    http,
    async loginAs(email, password) {
      const res = await http().post('/api/auth/sign-in/email').send({ email, password }).expect(200);
      const token = res.headers['set-auth-token'];
      if (typeof token !== 'string' || !token) throw new Error(`no bearer token for ${email}`);
      return token;
    },
    emailsTo,
    linkToken(email, page) {
      const messages = emailsTo(email);
      const escaped = page.replace('/', '\\/');
      for (const m of messages.reverse()) {
        const match = new RegExp(`${escaped}\\?token=([\\w-]+)`).exec(m.text);
        if (match?.[1]) return match[1];
      }
      throw new Error(`no ${page} link emailed to ${email}`);
    },
    async close() {
      await app.close();
      await db.drop();
      await auditDb.drop();
      rmSync(keyDir, { recursive: true, force: true });
    },
  };
}

export async function completeSetup(h: ApiHarness): Promise<string> {
  await h
    .http()
    .post('/v1/setup')
    .send({ setupToken: SETUP_TOKEN, orgName: 'Meridian Bank', adminName: 'Admin', adminEmail: ADMIN.email, adminPassword: ADMIN.password })
    .expect(201);
  return h.loginAs(ADMIN.email, ADMIN.password);
}

/**
 * A user with a password, written straight to the database (no invite email):
 * for tests whose email driver is a real provider, where the API only invites.
 */
export async function addUserWithPassword(h: ApiHarness, user: { email: string; name: string; role: 'TECH' | 'HEAD' | 'LEAD' | 'SERVICE'; password: string }): Promise<string> {
  const { hashPassword, setPasswordCredential } = await import('@ocso/application');
  const { users, uuidv7 } = await import('@ocso/db');
  const id = uuidv7();
  await h.db.db.insert(users).values({ id, email: user.email.toLowerCase(), name: user.name, role: user.role, emailVerified: true });
  await setPasswordCredential(h.db.db, id, await hashPassword(user.password));
  return id;
}
