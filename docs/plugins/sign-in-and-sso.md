# Sign-in methods and SSO

Authentication is [Better Auth](https://www.better-auth.com/) running in-process in the api (ADR-025).
Authorization stays in OCSO code: roles map to permissions, a deny-by-default guard checks every route,
and services check resources and team scope.

This is not an OCSO plugin contract. Sign-in methods are Better Auth plugins configured in one file.
Identity providers, on the other hand, are runtime configuration: a Platform Tech Admin adds them in the
web app with no code.

## What is enabled

`packages/application/src/identity/auth/server.ts` configures:

| Method | Better Auth piece | Notes |
|---|---|---|
| Email and password | core `emailAndPassword` | sign-up disabled; users are invited; passwords at least 12 characters |
| TOTP with 10 backup codes | `twoFactor` | backup codes stored encrypted with `BETTER_AUTH_SECRET` |
| Passkeys (WebAuthn) | `@better-auth/passkey` | relying party = host of `OCSO_PUBLIC_URL`; user verification required |
| OIDC and SAML 2.0 SSO | `@better-auth/sso` | providers added in the web app; SAML IdP-initiated sign-in off |
| Bearer sessions for the BFF | `bearer` (signed) | `/v1` never accepts cookies |
| OCSO policy | `ocsoPolicy` (`policy-plugin.ts`) | idle timeout, MFA-required roles, HTTP endpoint allowlist, audit |

**Settings → Sign-in security** lets the Tech Admin require a second factor for chosen roles. Passkey
and SSO sessions count as multi-factor.

## Adding an identity provider (no code)

**Settings → Sign-in security → Add SSO provider**: OpenID Connect (issuer URL, client ID, client
secret) or SAML 2.0 (IdP sign-on URL, entity ID, signing certificate), plus the email domains it serves.
OCSO runs the OIDC discovery itself, restricted to the issuer's own origin, which must be public or listed
in `OCSO_AUTH_TRUSTED_ORIGINS`. Sign-in links an existing user by email. Unknown users are refused
unless the provider has auto-provisioning on, which creates them as CS Execs. Provider management goes
through OCSO's `/v1/settings/sso-providers` API, so it is permission-checked and audited. Setup steps:
[docs/operations/setup-guide.md §1](../operations/setup-guide.md#1-first-run-platform-tech-admin).

The OIDC client secret is stored by Better Auth in `auth_sso_providers.oidc_config` in PostgreSQL, not
in OCSO's SecretStore (ADR-025). It is write-only in the UI. Protect database backups accordingly.

## Adding a sign-in method (code)

1. Add the Better Auth plugin in `authOptions()` in `server.ts`, before `bearer` and `ocsoPolicy`.
2. Add its browser-facing endpoints to `HTTP_AUTH_ENDPOINTS` in
   `packages/application/src/identity/auth/endpoints.ts`. Every Better Auth endpoint not on this list
   answers 404 over HTTP, including new ones from a Better Auth upgrade.
3. If an endpoint completes a sign-in, map it in `SIGN_IN_METHODS` so the session records its method
   (`password`, `mfa`, `passkey` or `sso`); that drives the MFA policy.
4. Add any successful action worth auditing to `AUDITED_ENDPOINTS`.
5. Update the pinned list in `apps/api/test/unit/auth-surface.test.ts`, and add a migration if the plugin
   needs tables (`packages/db/src/schema/auth.ts`).

## Tests to copy

`apps/api/test/int/auth.int.test.ts`, `auth-mfa.int.test.ts`, `auth-sessions.int.test.ts` and
`auth-sso.int.test.ts` (against a local OIDC provider in `mini-idp.ts`);
`packages/application/test/sso-provisioning.test.ts`; `apps/web/e2e/auth-and-roles.spec.ts`.

## Limits today

- Email one-time codes as a second factor are not enabled; TOTP and backup codes are.
- There is no "SSO only" enforcement per domain: users who have a password can still use it.
- `BETTER_AUTH_SECRET` is deployment bootstrap. Rotating it signs everyone out and invalidates enrolled
  authenticator apps.
