# @ocso/channels

Channel adapters for OCSO (docs/07, ADR-007). An adapter handles transport only: request verification, identity extraction, inbound normalization into canonical `InteractionPart`s, media retrieval, rendering, sending, delivery statuses and capability declaration. Adapters never persist anything, never run the agent loop and never log.

| Adapter | Factory | Transport |
|---|---|---|
| `WhatsAppChannelAdapter` | `createWhatsAppAdapter({ fetch, now })` | WhatsApp Cloud API, called directly (Graph API version comes from config) |
| `WebChatChannelAdapter` | `createWebChatAdapter({ now, generateId? })` | OCSO's own widget: JSON in, realtime stream out |

Register both adapters with `ChannelRegistry`. Callers look adapters up by `kind`; they never switch on it.

---

## WhatsApp

### Setup (Meta side)

1. **Meta app.** In developers.facebook.com, create a *Business* app and add the **WhatsApp** product. Add or register the business phone number. Note two IDs:
   - the **Phone number ID** (not the phone number itself), which goes in `settings.phoneNumberId`;
   - the **WhatsApp Business Account ID**, which goes in the optional `settings.businessAccountId`. When it is set, webhook entries for other WABAs are ignored.
2. **System user token.** In Business Settings, go to Users, then System users. Create a system user and assign it the app and the WABA. Generate a **permanent** token with `whatsapp_business_messaging` and `whatsapp_business_management`. This goes in `secrets.accessToken`. Don't use the 24-hour temporary token from the API Setup page in production.
3. **App secret.** App settings, then Basic, then App secret. This goes in `secrets.appSecret`. It is used to verify `X-Hub-Signature-256`.
4. **Verify token.** Pick any random string of at least 16 characters, for example `openssl rand -hex 16`. This goes in `secrets.verifyToken`.
5. **Webhook.** Under WhatsApp, then Configuration, set:
   - Callback URL: `https://<ocso-public-host>/api/channels/whatsapp/:channelId/webhook`
   - Verify token: the value from step 4

   Subscribe to these webhook fields:
   - **`messages`**: this carries inbound messages *and* delivery statuses.
   - **`user_id_update`**: BSUID rotation. It is surfaced as `envelope.identityUpdates`.
6. Subscribe the app to the WABA: `POST /{WABA_ID}/subscribed_apps` using the system-user token. The dashboard does this when you use its flow.

### Channel settings

| Setting | Default | Notes |
|---|---|---|
| `phoneNumberId` | (required) | Default sending number. Inbound `metadata.phone_number_id` becomes `InboundMessage.channelAccountId`. Sends use `target.channelAccountId` when present, so one channel can serve several numbers of one WABA. |
| `businessAccountId` | none | WABA filter for inbound entries. |
| `graphApiVersion` | `v26.0` | Pin this and upgrade deliberately. Graph versions expire about 2 years after release. |
| `graphBaseUrl` | `https://graph.facebook.com` | Override it for tests or a proxy. Must be https, except on localhost. |
| `outboundMediaMode` | `link` | `link`: Meta downloads a short-lived signed BlobStore URL, so blob storage must be internet-reachable. `upload`: bytes are uploaded to `/{phone-number-id}/media` first. |
| `mediaLinkTtlSeconds` | `900` | TTL of signed links in `link` mode. |
| `requestTimeoutMs` / `mediaDownloadTimeoutMs` | `15000` / `60000` | |

Secrets: `accessToken`, `appSecret`, `verifyToken`. Call `validateConfig` before saving. It returns problems as readable text and never echoes secret values.

### Webhook handling (API side)

```ts
// NestJS: NestFactory.create(AppModule, { rawBody: true }); raise the JSON body limit to >= 3 MB.
const verdict = adapter.verifyRequest(req, channel);          // GET -> challenge, POST -> HMAC over RAW body
if (verdict.kind === 'challenge') return reply.status(200).type('text/plain').send(verdict.body);
if (verdict.kind === 'rejected') return reply.status(verdict.status).send();
const envelope = adapter.parseInbound(req, channel);          // throws DomainError(validation) on non-JSON
await ingress.persist(envelope);                              // idempotent on externalMessageId (wamid)
return reply.status(200).send();                              // ack ONLY after persisting (Meta retries for 7 days)
```

- **Idempotency:**
  - Messages dedupe on `externalMessageId`, which is the `wamid`. Meta redelivers.
  - Statuses dedupe on `(externalMessageId, status)` and are applied with `nextDeliveryStatus`, so a status never moves backwards and `failed` is terminal.
- **Batches:** one POST can hold many entries, changes, messages and statuses. The adapter parses each item on its own:
  - one malformed item never drops the rest of the batch;
  - unsupported events (`order`, `unsupported`, template status updates and similar) are counted in `envelope.ignored`.
- **Identity:**
  - Since 2026, Meta sends a business-scoped user id (BSUID, for example `US.1349…`). The adapter uses it as the primary identity (`whatsapp_bsuid`) and keeps the phone as an alternate in E.164 form (`whatsapp_phone`, `+16505551234`).
  - Users with a username may send a BSUID only.
  - `user_id_update` events and `system` `user_changed_number` messages become `envelope.identityUpdates`. Identity resolution must re-link these instead of creating new customers.

### Inbound normalization

| WhatsApp type | Canonical part |
|---|---|
| `text` | `TEXT` |
| `image`, `sticker` | `IMAGE`, with `media.status: 'PENDING'` and `source: { channel: 'WHATSAPP', externalId: <media id> }`. The sha256 is normalized from base64 to hex. |
| `audio` / `voice` | `AUDIO` (`voiceNote`) |
| `video`, `document` | `VIDEO`, `DOCUMENT` (caption, filename) |
| `location` | `LOCATION` |
| `contacts` | `CONTACT` |
| `interactive.button_reply` / `list_reply` / `nfm_reply`, legacy `button` | `STRUCTURED` with schema `button_reply` / `list_reply` / `flow_reply`, plus `fallbackText` |
| `reaction` | `STRUCTURED` schema `reaction`, with `{ messageId, emoji \| null, action: 'added' \| 'removed' }`. An omitted or empty emoji means the reaction was removed. |
| click-to-WhatsApp `referral` | an extra `STRUCTURED` part with schema `referral` |
| `order`, `unsupported`, unknown | ignored (counted) |

### Media

A worker calls `adapter.fetchMedia(part.media, channel)` for each `PENDING` media part. The fetch runs in these steps:

1. Call `GET /{media-id}` to get a short-lived URL. The URL is valid for about 5 minutes and media ids for about 7 days, so copy media soon after ingest.
2. Check the download host against an allowlist: `*.fbcdn.net`, `*.fbsbx.com`, or the configured Graph origin, over https on the default port.
3. Download with `redirect: 'manual'`, re-checking every redirect hop. The token is only ever sent to allowlisted hosts.
4. Enforce the MIME allowlist and the per-kind size cap. The size is checked against the declared `file_size`, then `Content-Length`, then the streamed byte count.
5. Compute sha256 and verify it against the webhook digest and the Graph digest.

Failures throw `ChannelMediaError`:
- `error.rejected === true` means the media is unacceptable: too large, disallowed type, wrong host, or checksum mismatch. Store it as `REJECTED` with `rejectionReason = error.message`.
- Otherwise use `error.retriable` (a `DomainError` category) to choose between retry and `FAILED`.

### Outbound

- `render(parts)` works as follows:
  - It runs `customerSafeParts` first, so `TOOL_RESULT` and unsupported parts never render.
  - It converts CommonMark to WhatsApp formatting:
    - `**b**` becomes `*b*` and `*i*` becomes `_i_`; `~~s~~` becomes `~s~`;
    - code becomes monospace;
    - headings become bold lines;
    - tables become rows;
    - links become `text (url)`.
  - It chunks text to 4096 characters on paragraph, line, sentence or word boundaries, keeping code fences balanced.
  - Each `RenderedOutbound` carries its source `partIndexes`.
- Media parts must already be `STORED` in BlobStore. They stay as BlobStore references until send time, when they become a signed link or an uploaded media id.
- `STRUCTURED` with schema `buttons` and data `{ body, buttons: [{ id, title }], header?, footer? }` becomes interactive reply buttons, with at most 3 buttons and titles cut to 20 characters. Otherwise the adapter uses `fallbackText`. For more than 3 buttons with no fallback, it sends a numbered list.
- `send()` posts to `POST /{phone-number-id}/messages` and returns the `wamid`.
  - It checks the **24-hour window** first, using `target.lastInboundAt`. Outside the window, free-form sends return `{ ok: false, errorCode: 'outside_session_window', requiresTemplate: true }` without calling Meta.
- Templates can be sent outside the window with `sendTemplate(target, { name, language, components }, channel)`. Use `renderTemplate(...)` to store a template payload in the outbox.
- `markRead(wamid, channel, { typingIndicator: true })` sends blue ticks and a typing indicator for about 25 s.

Error mapping. Meta error codes are checked first; the HTTP status is the fallback:

| Meta code / HTTP | `errorCode` | retriable |
|---|---|---|
| 131047 | `outside_session_window` (`requiresTemplate: true`) | no |
| 131056 | `rate_limited_pair` | yes |
| 130429, 4, 17, 32, 613, 80007, HTTP 429 | `rate_limited` | yes |
| 190, 0, HTTP 401 | `auth_failed` | no |
| 3, 10, 200–299, HTTP 403 | `permission_denied` | no |
| 131026 / 131049 / 131050 / 131051 | `recipient_undeliverable` / `engagement_limited` / `recipient_opted_out` / `unsupported_message_type` | no |
| 132000–132999 | `template_error` | no |
| 131052 / 131053 | `media_download_failed` (yes) / `media_upload_failed` (no) | |
| 1, 2, 131000, 131016, 133004, HTTP 5xx | `provider_unavailable` / `provider_error` | yes |
| network error / timeout | `network_error` / `timeout` | yes |

Error messages are redacted: known secrets, bearer tokens and `access_token=` values are masked.

**At-least-once caveat.** Meta has no idempotency key for sends. If the process crashes between Meta accepting a message and OCSO recording the `wamid`, or a request times out after Meta accepted it, a retry can deliver a duplicate (ADR-007).
- Keep one outbox row per send.
- Record the returned `wamid` immediately.
- Match status webhooks through that `wamid`.

A 2xx response that has no message id is reported as non-retriable on purpose.

---

## Web chat

OCSO's first-party widget uses AI SDK UI `useChat` with an OCSO transport. It posts JSON through the OCSO API. The API endpoints are:
- `POST /public/webchat/:channel/messages`
- `GET /public/webchat/:channel/stream` (SSE)

### Authentication

- **Anonymous visitors.** The API calls `adapter.issueVisitorToken(channel)`, or passes `{ visitorId }` to renew a token. The widget keeps the token and sends it as `Authorization: Bearer <token>`.
  - Tokens are compact `wcv1.<claims>.<HMAC-SHA256>` strings.
  - They are signed with `secrets.visitorTokenSecret` (at least 32 characters) and bound to the channel id.
  - They expire after `settings.visitorTokenTtlSeconds` (default 30 days).
  - Rotating the secret revokes every token.
- **Authenticated customers.** The embedding host app signs an **HS256 JWT** with `secrets.hostJwtSecret`. Claims: `sub` = the host's customer id, `exp` (required), and optional `iat`, `nbf`, `iss`, `aud` and `name`.
  - Only `alg: HS256` is accepted.
  - `iss` and `aud` are enforced when `settings.hostJwtIssuer` or `settings.hostJwtAudience` is set.
  - The widget can send the JWT directly as the bearer token.
  - Alternatively, the API can verify it once and issue a visitor token with `{ externalCustomerRef }`.
  - Identity kind: `webchat_customer_ref`, with the visitor id kept as an alternate when known. Anonymous visitors use `webchat_visitor`.
- `verifyRequest` returns 401 for a missing or expired token, which tells the widget to refresh. It returns 403 for forged tokens and tokens bound to another channel.
- `adapter.identify(req, channel)` gives the upload and stream endpoints the same identity.

### Messages

```json
{ "clientMessageId": "msg_01J9ZK4Q7F", "text": "Here is the receipt",
  "attachments": [{ "blobKey": "webchat/<channelId>/<digest>/upl_01.jpg", "mimeType": "image/jpeg", "filename": "receipt.jpg", "sizeBytes": 48213 }],
  "structured": { "schema": "button_reply", "data": { "id": "yes" }, "fallbackText": "Yes" } }
```

- **Idempotency.** `externalMessageId` is `webchat:<identity digest>:<clientMessageId>`. A widget retry therefore dedupes, and two visitors can never collide.
- **Attachments.** The API uploads attachments straight into BlobStore, so they arrive as `STORED` parts. Before upload, the API validates each file's MIME type and size against capabilities. It must store each upload under `adapter.attachmentKeyPrefix(channel, identity)`. The parser rejects any other key, which stops one visitor attaching another visitor's upload.
- **`fetchMedia`** doesn't apply to web chat and throws `ChannelMediaError('not_applicable')`.
- **`render`** returns one `{ type: 'message', parts }` payload containing only customer-safe parts. CommonMark is left unchanged for the widget.
- **`send` does no network I/O.** Web chat delivery happens over the realtime stream (outbox, then `LISTEN/NOTIFY`, then SSE; see ADR-009). `send` validates the payload and returns a generated `webchat-out:<id>`, so the outbox and delivery status look the same as on other channels.

---

## Security notes

- **WhatsApp POST verification.**
  - Signatures are HMAC-SHA256 over the **raw** body, compared in constant time. A re-serialized body fails verification.
  - A missing header returns 401; an invalid signature returns 403.
  - Verify-token comparison is constant-time and does not leak the token's length.
  - The GET challenge is echoed only when it is a safe token, so arbitrary content is never reflected back.
- **No secrets leave the adapter:**
  - errors carry redacted, length-bounded provider text;
  - `validateConfig` never echoes secret values;
  - the access token is sent only in the `Authorization` header, and only to Graph or allowlisted Meta CDN hosts.
- **Graph URL construction.** Ids are checked before they are used in a Graph URL, so values like `../me/accounts` are refused. Graph API requests use `redirect: 'error'`.
- **Customer-facing output.** Only customer-safe parts ever reach a channel. `TOOL_RESULT` parts are dropped in three places: the policy, the capability filter and the renderer.
- **Web chat tokens:**
  - tokens are channel-bound and expiring, with 60 s of allowed clock skew;
  - host JWTs have their algorithm pinned to HS256;
  - attachment keys are scoped to the owning identity;
  - body size, attachment count and text length are capped.

## Needs live verification

All tests run offline, using a fake `fetch` and Meta-shaped fixtures. Check these against a real WhatsApp Business number before production:

- **Signatures and routing:** the webhook signature against a real Meta delivery, including the raw-body handling in the NestJS app.
- **BSUID payloads:** the exact BSUID field names (`from_user_id`, `contacts[].user_id`, `user_id_update`), and whether Meta accepts `recipient` sends to a BSUID.
- **Media download:**
  - the `sha256` encoding in both webhook and Graph responses (the adapter accepts hex and base64);
  - the `Content-Type` that Meta's CDN returns (a specific type that contradicts the declared type is rejected);
  - the CDN hostnames, including redirects.
- **Media upload:** multipart upload (`upload` mode) and Meta's fetch of signed links (`link` mode). Blob storage must be internet-reachable for `link` mode.
- **Rendering:**
  - how WhatsApp clients display the formatting, including inline code and quotes;
  - interactive reply buttons;
  - contacts messages with only `formatted_name` and `first_name`.
- **Error codes:** real error payloads for 131047, 131056, 130429 and 190, and whether Meta surfaces 131049 at send time or only in a status.
- **Supported MIME types:** inbound documents of types outside Meta's list (for example `.csv`) are rejected by the capability allowlist. Widen the list if the business needs them.
