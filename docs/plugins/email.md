# Email senders

OCSO sends invites, password resets, email verification, sign-in notices and alert emails through one
deployment-wide sender. Email is part of authentication, so the sender is chosen by the operator in the
environment (`EMAIL_DRIVER`) and never configured in the web app. **Settings → Email** only shows what
is configured and has a **Send test email** button.

Shipped in `packages/email/src/`:

| Driver | File | Notes |
|---|---|---|
| `resend` | `resend-sender.ts` | Resend HTTPS API; sends an `Idempotency-Key` |
| `smtp` | `smtp-sender.ts`, `smtp-transport.ts` | any relay; STARTTLS required unless `SMTP_REQUIRE_TLS=false`; stable Message-ID per idempotency key |
| `log` | `log-sender.ts` | development and tests: nothing leaves the process |

Operator setup: [docs/operations/compose.md §9](../operations/compose.md#9-email-resend-or-smtp).

## The contract

`packages/email/src/contract.ts`, trimmed:

```ts
export type EmailDriver = 'resend' | 'smtp' | 'log';

export interface EmailSender {
  readonly driver: EmailDriver;
  /** Sender address used for every message (EMAIL_FROM). */
  readonly from: string;
  /** Throws EmailSendError; `retriable` tells callers whether a retry can help. */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailSendError extends Error {
  constructor(message: string, readonly retriable: boolean, readonly status: number | null = null,
              readonly category: EmailErrorCategory = 'unknown') { … }
}
```

`EmailMessage` carries `to`, `subject`, `html`, `text`, optional `replyTo`, low-cardinality `tags`, and an
`idempotencyKey` ("same key → the provider sends at most once"). `category` (`auth`, `validation`,
`rate_limited`, `unavailable`, `network`) is what the test button reports.

## How one is registered

This extension point is a driver switch, not a registry. `packages/email/src/config.ts`:

- `resolveEmailConfig(env)` validates the `EMAIL_*`, `RESEND_*` and `SMTP_*` variables (and their
  `*_FILE` forms) at start-up and throws one error listing every problem, without secret values. In
  production, `EMAIL_DRIVER` is required, and `log` is refused unless
  `EMAIL_ALLOW_LOG_IN_PRODUCTION=true`.
- `senderFor(config)` switches on the driver and constructs the sender.

Adding a driver means extending `EmailDriver`, the `EMAIL_DRIVER` enum in
`packages/config/src/env.ts`, `resolveEmailConfig` and `senderFor`.

## What the core does for you

- Typed templates with HTML and plain-text bodies (`src/templates/auth.ts`, `alert.ts`, shared
  `layout.ts`), so a sender only transports a finished message.
- One sender instance (`EMAIL_SENDER`) injected into the api and the worker. Better Auth's mailer and
  email alert destinations use it.
- The Settings → Email status and test button, from the secret-free `emailStatus(config)`.

## Tests to copy

`packages/email/test/resend.test.ts` and `smtp.test.ts` (fake `fetch` and a fake mail transport:
payload shape, idempotency, error categories, secret redaction) and `config.test.ts` (start-up
validation).

## Limits today

- The set of drivers is closed and selected with a `switch`. That is acceptable for a bootstrap setting
  read once at start-up, but it is not a registry.
- One sender per deployment. There is no per-message or per-team sender.
