import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';

export interface ApiHarness {
  app: INestApplication;
  db: TestDatabase;
  http: () => ReturnType<typeof request>;
  loginAs(email: string, password: string): Promise<string>;
  close(): Promise<void>;
}

export const SETUP_TOKEN = 'integration-setup-token-1';
export const ADMIN = { email: 'admin@ocso.test', password: 'admin password 1234' };

/** Boot the real AppModule against a fresh migrated database. */
export async function startApi(): Promise<ApiHarness> {
  const db = await createTestDatabase();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    BLOB_SIGNING_KEY: 'test-blob-signing-key-0123456789',
    OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    OCSO_SETUP_TOKEN: SETUP_TOKEN,
    BLOB_LOCAL_DIR: `/tmp/ocso-test-blobs-${db.name}`,
    LOG_LEVEL: 'error',
  });
  const { createApp } = await import('../../src/bootstrap.js');
  const app = await createApp({ logger: false });
  await app.init();
  const http = () => request(app.getHttpServer());
  return {
    app,
    db,
    http,
    async loginAs(email, password) {
      const res = await http().post('/v1/auth/login').send({ email, password }).expect(200);
      return res.body.token as string;
    },
    async close() {
      await app.close();
      await db.drop();
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
