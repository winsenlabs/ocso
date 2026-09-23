/**
 * Better Auth endpoints reachable over HTTP at /api/auth/* (ADR-025), by route
 * template. Browsers reach them through the web app's proxy; the web BFF calls
 * them server to server. Every other Better Auth endpoint — sign-up, user
 * updates, account linking, SSO provider management (OCSO's /v1 API does that
 * with its own authorization and audit), OAuth token access — answers 404 over
 * HTTP and is usable only in-process. Deny by default: a new endpoint from a
 * Better Auth upgrade stays unreachable until it is added here deliberately
 * (apps/api/test/unit/auth-surface.test.ts pins this list).
 */
export const HTTP_AUTH_ENDPOINTS: ReadonlySet<string> = new Set([
  // Email + password
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  '/request-password-reset',
  '/reset-password',
  '/change-password',
  // Sessions (Account security → active sessions)
  '/list-sessions',
  '/revoke-session',
  '/revoke-other-sessions',
  // TOTP second factor with backup codes
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/generate-backup-codes',
  // Passkeys (WebAuthn, rpID = host of OCSO_PUBLIC_URL)
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  // SSO sign-in (OIDC + SAML 2.0); providers are managed through /v1
  '/sign-in/sso',
  '/sso/callback/:providerId',
  '/sso/saml2/sp/acs/:providerId',
  '/sso/saml2/sp/metadata',
  // Better Auth's error page (SSO failures without an error callback)
  '/error',
]);

/** Endpoints a session whose role requires MFA may use before it has a second factor: enrol TOTP or leave. */
export const PENDING_MFA_ENDPOINTS: ReadonlySet<string> = new Set(['/get-session', '/sign-out', '/two-factor/enable', '/two-factor/verify-totp']);

/** Endpoints that complete a sign-in, and the method they record on the session. */
export const SIGN_IN_METHODS: Readonly<Record<string, 'password' | 'mfa' | 'passkey' | 'sso'>> = {
  '/sign-in/email': 'password',
  '/two-factor/verify-totp': 'mfa',
  '/two-factor/verify-backup-code': 'mfa',
  '/two-factor/verify-otp': 'mfa',
  '/passkey/verify-authentication': 'passkey',
  '/sso/callback/:providerId': 'sso',
  '/sso/callback': 'sso',
  '/sso/saml2/sp/acs/:providerId': 'sso',
};

/** Endpoints OCSO audits on success (sign-ins are audited separately). */
export const AUDITED_ENDPOINTS: Readonly<Record<string, { action: string; summary: string }>> = {
  '/change-password': { action: 'auth.password_change', summary: 'changed their password and ended their other sessions' },
  '/two-factor/enable': { action: 'auth.mfa_enrollment_started', summary: 'started authenticator app enrollment' },
  '/two-factor/disable': { action: 'auth.mfa_disabled', summary: 'turned off two-factor authentication' },
  '/two-factor/generate-backup-codes': { action: 'auth.mfa_backup_codes_regenerated', summary: 'generated new backup codes' },
  '/passkey/verify-registration': { action: 'auth.passkey_added', summary: 'added a passkey' },
  '/passkey/delete-passkey': { action: 'auth.passkey_removed', summary: 'removed a passkey' },
  '/passkey/update-passkey': { action: 'auth.passkey_renamed', summary: 'renamed a passkey' },
  '/revoke-session': { action: 'auth.session_revoked', summary: 'signed out one of their sessions' },
  '/revoke-other-sessions': { action: 'auth.sessions_revoked', summary: 'signed out all their other sessions' },
};
