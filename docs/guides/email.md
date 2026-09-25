# Email

This guide covers how OCSO sends email: which driver to choose (`resend`, `smtp` or `log`), every environment
variable, what OCSO sends, and how to check it. It is for the operator who deploys OCSO and the Tech admin who checks
delivery.

Email is part of authentication (invites and password resets), so the sender is deployment bootstrap: it is set in
the environment and never in the web app. **Settings → Email** only shows what is configured and sends a test
message. The drivers are plugins registered by the `@ocso/email` package
([packages/email/src/drivers.ts](../../packages/email/src/drivers.ts)); see
[Plugins](../concepts/plugins.md) for adding another one.

## Drivers

| `EMAIL_DRIVER` | Label | Delivers | Use |
|---|---|---|---|
| `resend` | Resend | yes | Resend's HTTPS API. Sends an `Idempotency-Key`, so a retried message is sent at most once. |
| `smtp` | SMTP | yes | Any SMTP relay (Amazon SES, Postmark, Mailgun, your own). STARTTLS required unless turned off. A stable `Message-ID` per message lets receivers drop duplicates. |
| `log` | Log — development only | no | Messages are recorded and logged as one line (`email (log driver) to=… subject="…"`), never sent. |

When `EMAIL_DRIVER` is unset, `log` is used in development and test. In production (`NODE_ENV=production`):

- `EMAIL_DRIVER` must be set, and a non-delivering driver (`log`) is refused, unless
  `EMAIL_ALLOW_LOG_IN_PRODUCTION=true`. Then OCSO starts with a warning: nobody receives invites or password resets.
- A delivering driver requires `EMAIL_FROM`.
- An unknown driver name fails start-up and lists the registered drivers.

> [!IMPORTANT]
> The Compose file sets `EMAIL_ALLOW_LOG_IN_PRODUCTION` to `true` by default so a trial starts without email. Set
> `EMAIL_DRIVER` before you invite anyone, and set `EMAIL_ALLOW_LOG_IN_PRODUCTION=false` to make missing email a
> start-up error.

With a non-delivering driver, OCSO hands the invite or reset link to the admin in the web app instead of emailing it.

## Environment variables

Set these on both the api and the worker. Every problem is reported at start-up in one message, without secret
values.

| Variable | Driver | Purpose |
|---|---|---|
| `EMAIL_DRIVER` | all | `resend`, `smtp` or `log` (or a plugin's driver name). |
| `EMAIL_FROM` | resend, smtp | Sender, e.g. `Meridian Support <support@mail.meridian.example>`. Must be on a domain verified with your provider. |
| `EMAIL_REPLY_TO` | all | Optional reply-to address. |
| `EMAIL_ALLOW_LOG_IN_PRODUCTION` | log | Accept a non-delivering driver in production (trials only). |
| `RESEND_API_KEY` | resend | The Resend API key. |
| `RESEND_API_KEY_FILE` | resend | File holding the key (preferred: keeps it out of `.env`). The Compose entrypoint resolves it. |
| `SMTP_URL` | smtp | `smtp://user:password@host:587` or `smtps://host:465`. Alternative to the discrete settings; discrete settings win where both are set. |
| `SMTP_HOST` | smtp | Relay host. Required unless `SMTP_URL` gives one. |
| `SMTP_PORT` | smtp | Default 587, or 465 when `SMTP_SECURE=true`. |
| `SMTP_SECURE` | smtp | Implicit TLS. Default true on port 465 (and for `smtps://`). |
| `SMTP_REQUIRE_TLS` | smtp | Require STARTTLS on non-TLS ports. Default true; set false only for a local relay such as Mailpit. |
| `SMTP_USER` | smtp | Relay user. Defaults to the address in `EMAIL_FROM` when a password is set. |
| `SMTP_PASSWORD` | smtp | Relay password. |
| `SMTP_PASSWORD_FILE` | smtp | File holding the password (preferred). |

A `*_FILE` that is missing or empty is a start-up error; the value itself is never printed.

## Set up Resend

1. In Resend, verify your sending domain and create an API key with sending access.
2. Put the key in a file on the secrets volume, e.g. `/run/secrets/ocso/resend_api_key`.
3. Set, for the api and worker:

   ```bash
   EMAIL_DRIVER=resend
   EMAIL_FROM="Meridian Support <support@mail.meridian.example>"
   EMAIL_REPLY_TO=support@meridian.example
   RESEND_API_KEY_FILE=/run/secrets/ocso/resend_api_key
   EMAIL_ALLOW_LOG_IN_PRODUCTION=false
   ```

4. Restart the api and worker.

## Set up SMTP

```bash
EMAIL_DRIVER=smtp
EMAIL_FROM="Meridian Support <support@mail.meridian.example>"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASSWORD_FILE=/run/secrets/ocso/smtp_password
EMAIL_ALLOW_LOG_IN_PRODUCTION=false
```

For implicit TLS use `SMTP_PORT=465` (secure is then on by default). For a local catcher such as Mailpit in
development, `SMTP_REQUIRE_TLS=false`.

## What OCSO sends

| Email | Subject | When |
|---|---|---|
| Invite | `<inviter> invited you to <org> on OCSO` | A new user's creation is approved, or an admin resends the invite. Links to `/invite`. |
| Password reset | `Reset your OCSO password` | **Forgot password?**, or an admin sends a reset. Links to `/reset-password`; valid one hour. |
| Password changed | `Your OCSO password was changed` | A user changes their password. Links to `/forgot-password` in case it was not them. |
| Approval notices | `[OCSO] <outcome>: <change title>` | To the named checker when a change is submitted; to the maker when it is approved, rejected, blocked or voided, or when the checker can no longer approve. |
| Alert emails | `[OCSO <severity>] <title>` | Alert rules with an **Email** destination that uses **This server's email (EMAIL_DRIVER)**. See [Alerts and webhooks](alerts-and-webhooks.md). |

Every message has an HTML and a plain-text body. Links are built from `OCSO_PUBLIC_URL`.

Templates for email verification, sign-in codes and new-sign-in notices exist in
[packages/email/src/templates/auth.ts](../../packages/email/src/templates/auth.ts), but no code sends them today.

## Verify it works

1. Sign in as a Tech admin and open **Settings**. The **Email** section shows **driver**, **from**, **reply-to** and a
   **status**, plus any warnings.
2. Enter an address in **Send a test email to** and click **Send test email**. It uses the deployment's current
   configuration. A failure is reported by category: authentication, validation, rate limited, unavailable or
   network.
3. Invite a test user and check the invite arrives.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Start-up error `EMAIL_DRIVER is required in production` | Set a driver, or `EMAIL_ALLOW_LOG_IN_PRODUCTION=true` for a trial. |
| `EMAIL_DRIVER=resend requires EMAIL_FROM` | Set `EMAIL_FROM` on a verified domain. |
| `SMTP_PASSWORD requires SMTP_USER (or EMAIL_FROM as the user name)` | Set `SMTP_USER`. |
| Test fails with an authentication category | Wrong API key or relay credentials. |
| Test fails with a validation category | `EMAIL_FROM` is not on a domain your provider verified. |
| Users never get invites, no error | `EMAIL_DRIVER` is `log` (check the **status** on **Settings → Email**). |

## Limits and known gaps

- One sender per deployment. Alert email destinations can use their own SMTP relay; nothing else can.
- Email one-time sign-in codes are not enabled, even though the settings text mentions sign-in codes.
- The **Settings → Email** note and several comments point to `docs/operations/compose.md`; that content now lives in
  [Docker Compose deployment](deploy/docker-compose.md).

## Related

- [Sign-in, MFA and single sign-on](sign-in.md)
- [Alerts and webhooks](alerts-and-webhooks.md)
- [Docker Compose deployment](deploy/docker-compose.md)
- [Configuration reference](../reference/configuration.md)
- [packages/email/](../../packages/email/)
