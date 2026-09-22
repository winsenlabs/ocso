# 08: Transactional email — Resend, SMTP, templates

Researched 2026-09-22 against Resend's public docs. Implemented in `packages/email`.

Tags: **VERIFIED(docs)** means it comes from the vendor docs fetched today. **VERIFIED(run)** means
our unit or integration tests exercise it against a faked endpoint. **UNVERIFIED** means it has not
been checked against a live Resend account.

## TL;DR

- **Provider:** Resend over its HTTPS API. There is **no SDK**: one `fetch` POST, a timeout and error
  mapping. SMTP (nodemailer, reused from the alerts package) is the portable fallback, and `log` is the
  development driver.
- **Configuration is deployment bootstrap.** It comes from environment variables and secret files and
  is never stored in the database. The product owner's decision: email carries invites, resets and
  sign-in codes, so it is auth infrastructure.
  - `EMAIL_DRIVER` defaults to `log` in development and test.
  - Production requires `resend` or `smtp`. `log` there needs `EMAIL_ALLOW_LOG_IN_PRODUCTION=true`.
- **Templates:** plain typed TypeScript functions with escaped interpolation and a shared inline-styled
  table layout. We do **not use React Email.** The decision and reasons are below.
- **Idempotency:** every send can carry a key. Resend receives it as `Idempotency-Key`; SMTP gets a
  stable `Message-ID` derived from it. Alert deliveries use `alert-delivery/<deliveryId>`, so queue
  retries never send twice.

## Resend HTTP API — VERIFIED(docs)

| Item | Value |
|---|---|
| Send | `POST https://api.resend.com/emails`, `Authorization: Bearer re_…`, JSON body |
| Body | `from` (`"Name <addr>"`), `to` (string or array, **max 50**), `subject`, `html`, `text`, `reply_to`, `cc`, `bcc`, `headers`, `tags`, `scheduled_at`, `attachments`, `template` |
| Response | `200 { "id": "<uuid>" }` |
| Idempotency | `Idempotency-Key` header, 1–256 chars, kept **24 h**. Same key + same payload returns the original response without sending. Same key + different payload returns `409 invalid_idempotent_request`. Key still in flight returns `409 concurrent_idempotent_requests`. Also supported on `/emails/batch`. The SMTP equivalent is the `Resend-Idempotency-Key` header |
| Tags | `[{ name, value }]`: ASCII letters, digits, `_`, `-`, ≤ 256 chars each, up to 75 per email |
| Batch | `POST /emails/batch`, up to 100 emails, same idempotency header; no attachments |
| Rate limit | 10 requests/s per team by default (all keys); `429` plus `ratelimit-*` and `retry-after` headers |
| Error body | `{ statusCode, name, message }` |

Error codes and how we treat them (`classifyResendError`):

| Status | `name` examples | Retriable | Category |
|---|---|---|---|
| 400 | `validation_error`, `invalid_idempotency_key` | no | validation |
| 401 | `missing_api_key`, `restricted_api_key` | no | auth |
| 403 | `restricted_api_key`, `suspended_api_key`, `invalid_permission`, `validation_error` (domain not verified, testing-only sender) | no | auth |
| 404 / 405 | `not_found`, `method_not_allowed` | no | unknown (points at a wrong base URL) |
| 409 | `concurrent_idempotent_requests`, `resource_locked` | **yes** | unavailable |
| 409 | `invalid_idempotent_request` | no | validation |
| 422 | `missing_required_field`, `invalid_parameter`, … | no | validation |
| 429 | `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded` | **yes** | rate_limited |
| 5xx | `application_error`, `service_unavailable` | **yes** | unavailable |
| network / timeout | — | **yes** | network |

A timeout is ambiguous, because the email may already have gone out. It is still safe to retry,
because the retry carries the same idempotency key.

**Secrets in errors.** Error messages carry the status, Resend's `name` and its `message`, cut to 200
characters. Before that, the API key, anything shaped like `re_…`, and every email address are removed.
Recipients appear only as `N recipients @domain`. This is VERIFIED(run) in the unit tests and in the
API integration test.

**Domain setup** (VERIFIED(docs) plus secondary guides):
- Add a sending (sub)domain in Resend and publish the records it shows:
  - DKIM: a `TXT` record at `resend._domainkey`.
  - Return-Path: an `MX` record and an SPF `TXT` record on the `send` sub-subdomain.
- DMARC is yours to add; Resend does not create it.
- API keys are either *full access* or *sending access*, and a sending-access key can be restricted to
  one domain. OCSO needs only sending access.
- Operator steps: docs/operations/compose.md §9.

## Templates: plain typed HTML, not React Email — decision

React Email is what Resend recommends. It renders JSX components with `await render(<Email/>)` and
`toPlainText(html)`. It needs `react`, `react-dom`, the `react-email` package, a JSX build step in the
API and worker, and `html-to-text` for the text part. (VERIFIED(docs), react.email/docs/utilities/render.)

We chose small typed functions (`inviteEmail(input): RenderedEmail`) built on one shared layout
(`renderLayout`). The reasons:

1. **Lean API and worker.** They stay React-free and JSX-free, with no render step at runtime. The
   whole package depends only on nodemailer.
2. **One source for HTML and text.** Each template is a list of blocks: text, button, code, facts,
   note. The layout renders the HTML and the plain-text alternative from the same blocks. The text
   part is written, not scraped from HTML, so links and codes read correctly in it.
3. **Robust across clients by construction.** The layout uses:
   - one 560 px table-based card, bulletproof buttons (a `td` with `bgcolor`), and inline styles only;
   - system fonts;
   - no images, web fonts, `<style>` blocks, tracking pixels or external resources;
   - a raw link under every button for clients that break buttons.

   Seven fixed transactional templates do not need a component system.
4. **Security.**
   - Every interpolated value passes through `escapeHtml`.
   - Links must be absolute `http(s)` without credentials (`safeUrl` throws otherwise), and markup
     inside URLs is percent-encoded by `URL`.
   - Subjects and headings collapse control characters.
   - Tests inject `<script>`, quote-breaking URLs and CR/LF into every field.
5. **Deterministic output.** Dates are rendered with fixed month names, because ICU renders
   "Sep"/"Sept" depending on the version. Expiry is shown as relative time plus absolute time in the
   org's time zone.

**Revisit** if marketing-style or tenant-branded emails arrive. React Email could then run at build
time to pre-render templates into the same `RenderedEmail` shape without changing senders.

Templates:
- `inviteEmail`, `passwordResetEmail`, `emailVerificationEmail`.
- `signInCodeEmail`: the code appears in the body only, never in the subject or preview.
- `passwordChangedEmail` and `newSignInEmail`: the IP is coarsened to /24 or /48.
- `alertEmail`, which the alerts package now uses for both SMTP destinations and the deployment sender.

## SMTP

nodemailer 10, with bounded connection, greeting and socket timeouts. It uses one lazily created
transport per sender and drops it after a failure. Error classification:
- SMTP 4xx is transient; 5xx is permanent.
- `EAUTH`, `ETLS` and 530/535 map to `auth`.
- Server text is never echoed.

Resend also offers SMTP at `smtp.resend.com`, user `resend`, with the API key as password.

## Sources

- Send email: https://resend.com/docs/api-reference/emails/send-email
- Batch: https://resend.com/docs/api-reference/emails/send-batch-emails
- Errors: https://resend.com/docs/api-reference/errors
- Rate limit: https://resend.com/docs/api-reference/rate-limit
- Idempotency keys: https://resend.com/docs/dashboard/emails/idempotency-keys
- Tags: https://resend.com/docs/dashboard/emails/tags
- Domain verification troubleshooting: https://resend.com/docs/knowledge-base/what-if-my-domain-is-not-verifying
- Resend DNS records explained (secondary): https://www.getfluxly.com/blog/resend-domain-verification-dns
- React Email render: https://react.email/docs/utilities/render
