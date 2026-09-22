# Email senders

OCSO sends invites, password resets, email verification, sign-in notices and alert emails through one
deployment-wide sender. Email is part of authentication, so the sender is chosen by the operator in the
environment (`EMAIL_DRIVER`) and never configured in the web app. **Settings → Email** only shows what
is configured and has a **Send test email** button.

Shipped in `packages/email/src/`, registered as email drivers by the `@ocso/email` plugin
(`EMAIL_DRIVERS` in `drivers.ts`):

| Driver | Sender | Notes |
|---|---|---|
| `resend` | `resend-sender.ts` | Resend HTTPS API; sends an `Idempotency-Key`; key from `RESEND_API_KEY` or `RESEND_API_KEY_FILE` |
| `smtp` | `smtp-sender.ts`, `smtp-transport.ts` | any relay; STARTTLS required unless `SMTP_REQUIRE_TLS=false`; stable Message-ID per idempotency key; password from `SMTP_PASSWORD` or `SMTP_PASSWORD_FILE` |
| `log` | `log-sender.ts` | development and tests: nothing leaves the process (`delivers: false`) |

Operator setup: [docs/operations/compose.md §9](../operations/compose.md#9-email-resend-or-smtp).

## The contract

`packages/email/src/contract.ts`, trimmed:

```ts
/** A registered driver's name; the composition root validates it. */
export type EmailDriver = string;

export interface EmailSender {
  readonly driver: EmailDriver;
  /** Sender address used for every message (EMAIL_FROM). */
  readonly from: string;
  /** False when messages never leave the process (log); omitted = delivers. */
  readonly delivers?: boolean;
  /** Throws EmailSendError; `retriable` tells callers whether a retry can help. */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** An email driver: registered by name, selected by EMAIL_DRIVER. */
export interface EmailDriverDefinition<Options = unknown> {
  readonly name: string;          // EMAIL_DRIVER value, e.g. `resend`
  readonly label: string;         // Settings → Email, e.g. `Resend`
  readonly delivers: boolean;     // false: production refuses it unless EMAIL_ALLOW_LOG_IN_PRODUCTION=true
  /** Validate this driver's settings and resolve its secrets; report problems through ctx. */
  resolve(env: EmailEnv, ctx: EmailDriverContext): Options | null;
  create(options: Options, sender: { from: string; replyTo: string | null }, deps: EmailSenderDeps): EmailSender;
}

export class EmailSendError extends Error {
  constructor(message: string, readonly retriable: boolean, readonly status: number | null = null,
              readonly category: EmailErrorCategory = 'unknown') { … }
}
```

`EmailDriverContext` gives `resolve` the validated `from` address, the timeout, `secret(value, file,
name)` — the value, or the trimmed content of its `*_FILE`, recording a problem for a missing or empty
file without echoing it — and `problem(message)`.

`EmailMessage` carries `to`, `subject`, `html`, `text`, optional `replyTo`, low-cardinality `tags`, and an
`idempotencyKey` ("same key → the provider sends at most once"). `category` (`auth`, `validation`,
`rate_limited`, `unavailable`, `network`) is what the test button reports.

## How one is registered

Email drivers are a registry like the other plugin points. A plugin lists them in `emailDrivers`
(see [README.md](README.md#the-plugin-shape)); the composition root puts every plugin's drivers in one
`DriverRegistry` and the api and worker pass them to `packages/email/src/config.ts`:

- `resolveEmailConfig(env, { drivers })` picks the driver `EMAIL_DRIVER` names (default `log` when
  unset) — an unknown name fails with the list of registered drivers — applies the shared rules, then
  runs the driver's `resolve`. It throws one error listing every problem, without secret values. In
  production `EMAIL_DRIVER` is required, a driver with `delivers: false` is refused unless
  `EMAIL_ALLOW_LOG_IN_PRODUCTION=true`, and every delivering driver needs `EMAIL_FROM`.
- `senderFor(config)` calls the selected driver's `create`; `emailStatus(config)` is the secret-free
  view (driver, label, from, reply-to, `configured` = delivers, warnings).

Adding a driver is one `EmailDriverDefinition` in a plugin; nothing in `@ocso/config`, the api or the
web app changes (`EMAIL_DRIVER` is an open string, and Settings → Email shows the driver's `label`).

## What the core does for you

- Typed templates with HTML and plain-text bodies (`src/templates/auth.ts`, `alert.ts`, shared
  `layout.ts`), so a sender only transports a finished message.
- One sender instance (`EMAIL_SENDER`) injected into the api and the worker. Better Auth's mailer and
  email alert destinations use it. Where a driver does not deliver, invites and resets hand the admin
  the link instead (`EmailSender.delivers`).
- The Settings → Email status and test button, from `emailStatus(config)`.

## Tests to copy

`packages/email/test/resend.test.ts` and `smtp.test.ts` (fake `fetch` and a fake mail transport:
payload shape, idempotency, error categories, secret redaction) and `config.test.ts` (start-up
validation, the unknown-driver error, a third-party driver through the same contract).

## Limits today

- One sender per deployment. There is no per-message or per-team sender.
- The shared settings (`EMAIL_FROM`, `RESEND_*`, `SMTP_*`) are declared in `EmailEnv` and
  `@ocso/config`; a third-party driver reads settings of its own from `process.env`.
