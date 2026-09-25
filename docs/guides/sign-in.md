# Sign-in, MFA and single sign-on

This guide covers how staff sign in to OCSO: passwords, authenticator-app codes (TOTP), passkeys, and single sign-on
through OpenID Connect or SAML 2.0. It also covers requiring a second factor per role, SSO auto-provisioning, and
break-glass recovery when every Tech admin is locked out. It is for the Tech admin who sets sign-in up and for the
operator who runs the deployment.

Authentication is [Better Auth](https://www.better-auth.com/) running inside the api (ADR-025), configured in
[packages/application/src/identity/auth/server.ts](../../packages/application/src/identity/auth/server.ts).
Authorization stays in OCSO: presets (Tech, Head, Lead, Service) map to permissions, and a deny-by-default guard
checks every route. Customer sign-in on web chat is separate; see [Web chat](channels/web-chat.md).

## Methods

| Method | How it works | Counts as MFA |
|---|---|---|
| Email and password | Users are invited (no self sign-up). Passwords are 12–256 characters. **Forgot password?** emails a reset link valid for one hour; a reset ends every session. | no |
| Password + TOTP | An authenticator app, with 10 single-use backup codes (stored encrypted with `BETTER_AUTH_SECRET`). | yes |
| Passkey (WebAuthn) | Relying party = host of `OCSO_PUBLIC_URL`; user verification (fingerprint, face or PIN) required. **Use a passkey** on the sign-in page. | yes |
| SSO (OIDC or SAML 2.0) | **Continue with single sign-on** on the sign-in page; the email's domain selects the provider. | yes |

Users manage their own factors under **Settings → Account security: password, two-factor, passkeys, sessions**
(`/account/security`): **Add passkey**, turning two-factor on or off, **Generate new backup codes**, and ending
sessions.

Sessions last `SESSION_ABSOLUTE_HOURS` (default 24) and end after `SESSION_IDLE_MINUTES` of inactivity (default
120). There is no sliding refresh.

## Require MFA per role

1. Go to **Settings**. Under **Sign-in security**, tick roles in **Require MFA for roles**.
2. Click **Submit MFA policy for approval**. The change is a deployment-settings proposal that a second person
   approves.

Once approved, a user of a listed role who signed in with a password only is sent to set up an authenticator app
before anything else works (`MFA_ENROLLMENT_REQUIRED`), and cannot turn two-factor off. Passkey and SSO sign-ins
already count as MFA. A user whose per-user grants include a permission that a listed role holds and their own
preset does not is also required to use MFA.

> [!TIP]
> Keep at least one Tech admin with a password and a saved set of backup codes. That account is your way back in if
> the identity provider breaks.

## Add an SSO provider

Only a Tech admin (`deployment_settings.manage`) sees the **Single sign-on** section of **Settings**.

1. Go to **Settings → Single sign-on** and click **Add SSO provider**.
2. Choose **Protocol**: **OpenID Connect** or **SAML 2.0**, and fill in the common fields:

| Field | Notes |
|---|---|
| **Display name** | Shown to admins; up to 80 characters. |
| **Provider id** | Lowercase letters, digits and dashes, e.g. `okta`. Used in the callback URL. Cannot be changed later. |
| **Email domains** | Comma-separated. Only addresses on these domains may sign in with this provider, and they select it on the sign-in page. |
| **Create unknown users on first sign-in (as Service member). Off: only invited users.** | Auto-provisioning; default off. |

3. Protocol fields:

   **OpenID Connect**

   | Field | Notes |
   |---|---|
   | **Issuer URL** | Discovery at `<issuer>/.well-known/openid-configuration`. OCSO fetches it itself, only from the issuer's own origin, and only if that origin is publicly routable or listed in `OCSO_AUTH_TRUSTED_ORIGINS`. |
   | **Client ID** | From the IdP application. |
   | **Client secret** | Write-only. |

   OCSO requests the scopes `openid email profile` and uses PKCE. Register this redirect URI at the IdP:

   ```text
   <OCSO_PUBLIC_URL>/api/auth/sso/callback/<provider id>
   ```

   **SAML 2.0**

   | Field | Notes |
   |---|---|
   | **IdP single sign-on URL** | The IdP's SSO (entry point) URL. |
   | **IdP entity ID** | The IdP's entity id. |
   | **IdP signing certificate (PEM)** | Assertions must be signed; deprecated algorithms are rejected. |

   Configure the IdP application with:

   ```text
   ACS URL:        <OCSO_PUBLIC_URL>/api/auth/sso/saml2/sp/acs/<provider id>
   SP entity ID:   <OCSO_PUBLIC_URL>/api/auth/sso/saml2/sp/metadata?providerId=<provider id>
   SP metadata:    <OCSO_PUBLIC_URL>/api/auth/sso/saml2/sp/metadata?providerId=<provider id>
   ```

   OCSO reads the `email` attribute for the address and `displayName` for the name. IdP-initiated sign-in is off;
   users start from the OCSO sign-in page. `InResponseTo` and timestamps are validated.

4. Click **Add provider**. OCSO checks the provider (OIDC discovery runs now) and saves it as a **draft · sign-in
   refused**. The provider row shows the redirect URI or ACS URL and SP metadata URL to give your IdP admin.
5. Enable it from the row; a second person with `approvals.check.platform` approves. Only then does sign-in work.
   Once active, toggling auto-provisioning (**Auto-provision** / **Invited users only**) is a proposal too.

To change endpoints or secrets, delete the provider and add it again (deleting is a proposal).

### Who can sign in with SSO

On every SSO sign-in OCSO decides:

- The IdP must send an email on one of the provider's domains, or sign-in is refused (`sso_domain_not_allowed`).
- An existing active OCSO user with that email is linked (an invited user can accept their invite this way).
  Disabled and pending users are refused.
- An unknown email is refused (`sso_not_invited`) unless auto-provisioning is on.
- With auto-provisioning on, the unknown user is created as a **Service** member with status **pending approval**,
  and this first sign-in is refused. The user appears on **Team** as pending; someone with `users.manage` submits
  the creation and a checker with `approvals.check.permissions` (Head or Tech, never the person themself) approves.
  Their next SSO sign-in succeeds.

`OCSO_DEV_SKIP_ACCESS_APPROVAL=true` (development and test only; refused in production) creates provisioned users
active instead.

> [!NOTE]
> The OIDC client secret is stored by Better Auth in the `auth_sso_providers` table in PostgreSQL, not in OCSO's
> secret store (ADR-025). It is write-only in the UI. Protect database backups accordingly.

## Break-glass recovery

For a deployment whose Tech admins are all locked out (lost authenticators and backup codes, broken IdP, no email):

1. The operator sets `OCSO_RECOVERY_TOKEN` on the api to a random value of at least 32 characters and restarts it,
   for example `OCSO_RECOVERY_TOKEN=$(openssl rand -hex 32)`.
2. Open `<OCSO_PUBLIC_URL>/recover`. Enter the **Recovery token**, the **Tech admin email** and a **New password**
   (12 characters or more).
3. OCSO resets that Tech admin's password, removes their authenticator (they re-enrol at next sign-in if MFA is
   required), ends their sessions, revokes their Slack and Teams account links, and writes an audit entry
   (`auth.recovery`).
4. Remove `OCSO_RECOVERY_TOKEN` and restart. Each token value works once; to recover again, set a new value.

The endpoint behind the page is `POST /v1/setup/recover`. It works only for an **active Tech** user and only while
the variable is set.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `OCSO_PUBLIC_URL` | `http://localhost:3000` | Origin browsers use. Better Auth is served at `<origin>/api/auth`; passkeys bind to its host; callback URLs are built from it. |
| `BETTER_AUTH_SECRET` | none | At least 32 characters. Signs session cookies and encrypts TOTP secrets and backup codes. Required in production (Compose keygen generates it; `BETTER_AUTH_SECRET_FILE` is resolved by the entrypoint). |
| `SESSION_IDLE_MINUTES` | `120` | Idle timeout. |
| `SESSION_ABSOLUTE_HOURS` | `24` | Absolute session lifetime. |
| `SESSION_COOKIE_SECURE` | true when `OCSO_PUBLIC_URL` is https | `Secure` cookies with the `__Secure-` prefix. |
| `OCSO_AUTH_TRUSTED_ORIGINS` | none | Extra origins Better Auth trusts, comma-separated; for an IdP on a private network. |
| `OCSO_AUTH_RATE_LIMIT` | on | Better Auth's database-backed rate limiter. Turn off only for load tests. |
| `OCSO_RECOVERY_TOKEN` | none | Break-glass recovery, above. |
| `OCSO_DEV_SKIP_ACCESS_APPROVAL` | off | Development and test only. |

Full list: [Configuration reference](../reference/configuration.md).

## Verify it works

- Sign in with a password, then add a passkey and sign out and back in with **Use a passkey**.
- After approving an SSO provider, sign in with **Continue with single sign-on** using an address on its domain.
- **Audit log** shows `auth.login` with the method (password, password + second factor, passkey, sso).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Single sign-on is not set up for this email domain." | No active provider lists that domain (a draft provider refuses sign-in). |
| `OIDC discovery failed` when adding a provider | The issuer is not publicly reachable and not in `OCSO_AUTH_TRUSTED_ORIGINS`, or the discovery document is invalid. |
| "Your OCSO account is waiting for approval" | Auto-provisioned user; approve their creation on **Team**. |
| "You do not have an OCSO account yet" | Auto-provisioning is off and the user was not invited. |
| Passkey prompt fails | The browser is not on `OCSO_PUBLIC_URL`'s host (relying party mismatch). |
| Everyone signed out after a restart | `BETTER_AUTH_SECRET` changed. It also invalidates enrolled authenticator apps. |

## Limits and known gaps

- Email one-time codes as a second factor are not enabled; TOTP, backup codes, passkeys and SSO are.
- No "SSO only" enforcement per domain: users who have a password can still use it.
- The SAML form has no fields for IdP metadata XML or custom attribute names; the API accepts `metadataXml`,
  `emailAttribute` and `nameAttribute`.
- SCIM provisioning and group-to-role mapping are not supported; provisioned users are always Service members.
- Rotating `BETTER_AUTH_SECRET` signs everyone out and invalidates enrolled authenticator apps.

## Related

- [Governance and approvals](../concepts/governance.md)
- [Permissions reference](../reference/permissions.md)
- [Email](email.md): invites and password resets need a delivering email driver
- [First-run setup](first-run-setup.md)
- [Configuration reference](../reference/configuration.md)
