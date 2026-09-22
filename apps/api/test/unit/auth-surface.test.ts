import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA, MODULE_METADATA } from '@nestjs/common/constants.js';
import { AuthMailer, AuthPolicyService, DEFAULT_SESSION_POLICY } from '@ocso/application';
import { HTTP_AUTH_ENDPOINTS, PENDING_MFA_ENDPOINTS, createAuthServer } from '@ocso/application/auth-server';
import { createDatabase } from '@ocso/db';
import { LogEmailSender } from '@ocso/email';
import { AUTH_BASE_PATH } from '../../src/common/auth-handler.js';
import { FEATURE_MODULES } from '../../src/app.module.js';

/**
 * Better Auth is mounted at /api/auth outside Nest's controllers (ADR-025), so
 * the deny-by-default route test cannot see it. This pins its HTTP surface:
 * exactly these endpoints answer over HTTP; every other Better Auth endpoint
 * (sign-up, user updates, account linking, SSO provider management, token
 * access…) answers 404 and is reachable only in-process.
 */
const EXPECTED_HTTP_ENDPOINTS = [
  '/change-password',
  '/error',
  '/get-session',
  '/list-sessions',
  '/passkey/delete-passkey',
  '/passkey/generate-authenticate-options',
  '/passkey/generate-register-options',
  '/passkey/list-user-passkeys',
  '/passkey/update-passkey',
  '/passkey/verify-authentication',
  '/passkey/verify-registration',
  '/request-password-reset',
  '/reset-password',
  '/revoke-other-sessions',
  '/revoke-session',
  '/sign-in/email',
  '/sign-in/sso',
  '/sign-out',
  '/sso/callback/:providerId',
  '/sso/saml2/sp/acs/:providerId',
  '/sso/saml2/sp/metadata',
  '/two-factor/disable',
  '/two-factor/enable',
  '/two-factor/generate-backup-codes',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-totp',
];

function authServer() {
  // No query runs: listing endpoints needs no connection.
  const { db } = createDatabase({ connectionString: 'postgres://localhost:1/unused', maxConnections: 1, applicationName: 'unit' });
  const mailer = new AuthMailer({ db, sender: new LogEmailSender('OCSO <no-reply@ocso.test>'), publicUrl: 'http://localhost:3000' });
  return createAuthServer(
    { publicUrl: 'http://localhost:3000', secret: 'unit-test-secret-0123456789-0123456789', secureCookies: false, session: DEFAULT_SESSION_POLICY },
    { db, mailer, authPolicy: new AuthPolicyService(db), log: () => {} },
  );
}

describe('Better Auth HTTP surface', () => {
  it('is mounted at /api/auth', () => {
    expect(AUTH_BASE_PATH).toBe('/api/auth');
  });

  it('exposes exactly the reviewed endpoints over HTTP', () => {
    expect([...HTTP_AUTH_ENDPOINTS].sort()).toEqual([...EXPECTED_HTTP_ENDPOINTS].sort());
  });

  it('every allowlisted endpoint exists in Better Auth, and the rest stay closed', () => {
    const all = authServer().endpointPaths();
    for (const path of HTTP_AUTH_ENDPOINTS) expect(all).toContain(path);
    const closed = all.filter((p) => !HTTP_AUTH_ENDPOINTS.has(p));
    expect(closed).toEqual(expect.arrayContaining(['/sign-up/email', '/update-user', '/delete-user', '/sso/register', '/sso/update-provider', '/sso/delete-provider', '/link-social']));
  });

  it('a session still waiting for MFA enrolment can only enrol or leave', () => {
    expect([...PENDING_MFA_ENDPOINTS].sort()).toEqual(['/get-session', '/sign-out', '/two-factor/enable', '/two-factor/verify-totp']);
  });

  it('no Nest controller claims the /api/auth prefix', () => {
    type Ctor = new (...args: never[]) => unknown;
    const controllers = (FEATURE_MODULES as unknown as Ctor[]).flatMap((m) => (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, m) as Ctor[] | undefined) ?? []);
    const bases = controllers.map((c) => String(Reflect.getMetadata(PATH_METADATA, c) ?? ''));
    expect(bases.filter((b) => b.replace(/^\//, '').startsWith('api/auth'))).toEqual([]);
  });
});
