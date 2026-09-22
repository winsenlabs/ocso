# 02: Vercel Chat SDK and the WhatsApp Cloud API

Researched 2026-09-22. **Method:** I installed `chat@4.41.0`, `@chat-adapter/{whatsapp,web,state-pg,state-memory,shared}@4.41.0` and `ai@7.0.109` into a scratch directory. I then read the READMEs, the `.d.ts` files, the bundled `chat/docs/*.mdx` and the compiled `dist/*.js`. I also ran the WhatsApp adapter against signed test webhooks and a mock Graph server (scripts: `/private/tmp/claude-501/research-chat/exp/{test,react}.mjs`). Meta facts come from developers.facebook.com, fetched today. "VERIFIED(run)" means an experiment confirmed it. "VERIFIED(code)" means I read it in the shipped source. Anything else is marked UNVERIFIED.

## TL;DR

- Chat SDK is a **bot framework**, not a transport library. It owns webhook routing, dedupe, locks, subscriptions, handler dispatch and "reply in the handler". Its WhatsApp adapter only turns on inbound processing once you register it with a `Chat` instance and a `StateAdapter`.
- The WhatsApp adapter **drops delivery statuses completely**. It also drops `contacts` messages, sends every message from a single configured `phoneNumberId`, marks a message as deduped *before* your handler runs, and acks 200 before your handler finishes. All of these clash with OCSO's rules: statuses are required, acks happen only after the message is persisted, and the runtime is multi-number.
- **Recommendation: option (b), with a small addition.** Write WhatsApp Cloud API support directly in our `WhatsAppChannelAdapter`, which is roughly 500–700 lines. Use the MIT-licensed `@chat-adapter/whatsapp` source as a reference implementation and a source of test fixtures. Build web chat on **AI SDK UI** (`useChat` plus our own transport and endpoints), not `@chat-adapter/web`. Keep Chat SDK in reserve for *operator-facing* integrations later (Slack/Teams handoff and approvals), where its bot model fits.

## 1. What Chat SDK is (`chat` v4.41.0, github.com/vercel/chat)

- **Positioning:** "Universal TypeScript SDK for building multi-platform chat bots and AI agents on Slack, Teams, Google Chat, Discord, WhatsApp, and more." MIT license. About 2.4k stars. Last push 2026-09-18. All adapters are released in lockstep at 4.41.0.
- **Official packages (npm search, 2026-09-22):**
  - Platform adapters: `slack`, `teams`, `gchat`, `discord`, `telegram`, `whatsapp`, `twilio` (SMS/MMS), `web`, `github`, `linear`, `x`
  - State adapters: `state-memory`, `state-redis`, `state-ioredis`, `state-pg`
  - Support packages: `shared`, `tests`
  - Community: `chat-adapter-sendblue` (iMessage)
- **Core objects:**
  - `new Chat({ userName, adapters: {name: Adapter}, state: StateAdapter, concurrency?, lockScope?, dedupeTtlMs?, logger? })`. `state` is **required** (VERIFIED(code): `state: StateAdapter` in `ChatConfig`).
  - Handlers:
    - `onNewMention`, `onSubscribedMessage`, `onDirectMessage`, `onNewMessage(regex)`
    - `onReaction`, `onAction` (button/list clicks), `onModalSubmit`, `onSlashCommand`
    - Several Slack-specific handlers
  - `Thread`, `Channel` and `Message` (with `attachments[].fetchData()`), plus `thread.post(string | {markdown} | Card JSX | AsyncIterable)`, `thread.subscribe()` and `thread.setState()`.
  - Cards are JSX (`chat/jsx-runtime`), and each adapter renders them natively (Block Kit, Adaptive Cards, WhatsApp interactive messages).
  - Streaming: `thread.post(result.fullStream)` from the AI SDK. It streams natively where the platform supports it and falls back to post+edit elsewhere. **WhatsApp buffers the whole reply and sends it as one message.**
- **Optional peer deps** (VERIFIED(code+run): `peerDependenciesMeta` marks all three optional, and `import('chat')` works without them):
  - `ai` (^6 or ^7) is needed only by `chat/ai` (`toAiMessages`, tools) and by `@chat-adapter/web`.
  - `zod` is needed only by the `chat/ai` toolset.
  - `workflow` (^5 beta) is needed only by `chat/workflow` and `chat/serialization`, for Vercel Workflow.
- **State:** the `StateAdapter` interface covers subscriptions, locks (`acquireLock`, `extendLock`, `forceReleaseLock`), KV with TTL, `setIfNotExists` (dedupe), lists (message history) and queues (enqueue/dequeue).
  - Memory is for development. Redis, ioredis (cluster/sentinel) and **Postgres** are available for production.
  - `@chat-adapter/state-pg` creates tables `chat_state_{subscriptions,locks,cache,lists,queues}`. It supports `autoCreateSchema:false` plus exported `postgresSchemaStatements` for migrations, but has no schema option (it relies on `search_path`).
- **Concurrency** (per thread, or per *channel* for WhatsApp/Telegram):
  - The default is `"drop"`: a message that arrives while a handler holds the lock is **discarded** (LockError).
  - The alternatives are `queue`, `burst`, `debounce` and `concurrent`.
- **Dedupe:** the core calls `state.setIfNotExists("dedupe:<adapter>:<msgId>", ttl=10min)` **before** dispatch (VERIFIED(code) at `routeIncomingMessage`). It can be skipped with `WebhookOptions.deduplicate:false`.
- **Webhooks** use Web-standard `Request -> Response`: `bot.webhooks.whatsapp(request, { waitUntil })`. The adapter calls `processMessage()` **without awaiting it**. Handler work runs in the background and is only tracked if you pass `waitUntil`.
- **Framework-agnostic:** the bundled guides use Next.js, Hono (`c.req.raw`) and Nuxt (`toWebRequest`). Under NestJS 12 (current `@nestjs/core@12.0.4`) with Fastify or Express, you build a `Request` from `req.rawBody`. Enable it with `NestFactory.create(..., { rawBody: true })`.
  - Raise the body limit, because Meta payloads can reach **3 MB**. Nest's defaults are 100 KB for Express and 1 MiB for Fastify.

## 2. `@chat-adapter/whatsapp` v4.41.0

**Config:**
```ts
createWhatsAppAdapter({
  accessToken,   // WHATSAPP_ACCESS_TOKEN (System User token)
  appSecret,     // WHATSAPP_APP_SECRET (X-Hub-Signature-256)
  phoneNumberId, // WHATSAPP_PHONE_NUMBER_ID
  verifyToken,   // WHATSAPP_VERIFY_TOKEN (GET challenge)
  apiVersion?,   // default "v25.0"; current Graph is v26.0 (see section 5)
  apiUrl?,
  userName?,
  logger?,
})
```

**Exports (from `.d.ts`):**
- `WhatsAppAdapter`, `createWhatsAppAdapter`, `WhatsAppApiError`, `getWhatsAppMediaType`, `splitMessage`, `validateFileSize`.
- Types: `WhatsAppRawMessage`, `WhatsAppThreadId`, `WhatsAppTemplate{Message,Component,Parameter,ButtonParameter}`, `WhatsAppMediaResponse`, `WhatsAppGraphError(Body)`, `WhatsAppMediaType`, `WhatsAppAdapterConfig`.
- The format converter is **not** exported.

**Public methods on `WhatsAppAdapter`:**
- `handleWebhook(req, opts)`, `initialize(chat)`, `parseMessage(raw)`
- `postMessage` / `reply(threadId, …)`, `sendTemplate(threadId, tpl)`, `stream` (buffered)
- `markAsRead(msgId)`, `startTyping(threadId)`, `add/removeReaction`
- `downloadMedia(mediaId, transport?)`, `rehydrateAttachment`
- `openDM(waId)`, `encode/decodeThreadId` (`whatsapp:{phoneNumberId}:{waId|BSUID}`), `renderFormatted(ast)`, `splitMessage`
- Protected, and so only reachable by subclassing (not a stable API): `sendInteractiveMessage`, `sendMediaMessage`, `uploadMedia`, `graphApiRequest`, `verifySignature`, `extractTextContent`, `buildAttachments`.

**Behaviour checks:**

| Check | Result |
|---|---|
| GET `hub.mode=subscribe` + matching `hub.verify_token` | 200 and echoes `hub.challenge`. A wrong token returns 403. VERIFIED(run) |
| POST signature | HMAC-SHA256(appSecret, `await request.text()`) compared with `timingSafeEqual`. A bad signature returns 401. VERIFIED(run) |
| POST with no `Chat` initialized | **Returns 200 and silently ignores every message** ("Chat instance not initialized"). VERIFIED(run) |
| Inbound text, image, document, audio/voice, video, sticker | Becomes a `Message`, with lazy `attachments[].fetchData()` and `fetchMetadata.mediaId`. VERIFIED(run) |
| Location | Becomes the text `"[Location: …]"` plus a Google Maps URL attachment. Lat/lng are only available through `message.raw`. VERIFIED(code) |
| `contacts`, `order`, `unsupported` and other types | **Dropped** (`extractTextContent` returns null). VERIFIED(run) for contacts |
| Interactive `button_reply`/`list_reply`, template quick-reply `button` | Routed to `onAction`, not treated as a message. **Not deduped**: redelivery fired `onAction` again. VERIFIED(run) |
| Reactions | `onReaction`. Meta now signals removal by *omitting* `emoji`, and the adapter reports that as `added:true, emoji undefined`. This is a bug. VERIFIED(run) |
| **`statuses` (sent/delivered/read/failed)** | **Ignored completely.** Only `value.messages` and `user_id_update` are read. VERIFIED(code+run) |
| Ack timing | Returns 200 before handlers finish. You only get ack-after-persist if you collect `waitUntil` tasks and await them. VERIFIED(run) |
| Dedupe | Core sets the dedupe key before the handler runs. If the handler throws and Meta redelivers within 10 minutes, the message is **silently skipped**. VERIFIED(code) |
| Outbound routing | `postMessage("whatsapp:OTHER_PNID:…")` still POSTs to `/v25.0/<configured PNID>/messages`. That means **one adapter instance per business number**, and routing fan-in webhooks is left to us. VERIFIED(run) |
| Formatting | `**Hi**` becomes `*Hi*`, with 4096-character chunking. Cards map to reply buttons (at most 3, titles of 20 characters, body of 1024), list messages, or a single `cta_url`. More than 3 buttons falls back to text. VERIFIED(run/README) |
| Media download | Two-step Graph call. Host allowlist `fbcdn.net`/`fbsbx.com`, SSRF guard, **25 MB cap** (Meta allows documents up to 100 MB), 30 s timeout. VERIFIED(code) |
| Errors | `WhatsAppApiError{code: RATE_LIMITED\|AUTH_FAILED\|PERMISSION_DENIED\|NOT_FOUND, errorCode (Meta), details, status, traceId}` |
| Identity | Supports BSUID. Aliases and routes are stored in the Chat SDK state store, and `user_id_update` is handled. Inbound messages are also copied into state (`persistThreadHistory=true`), which duplicates PII outside our schema. VERIFIED(code) |

**Can we take only the pieces we need?**
- **Outbound:** yes. `postMessage`, `sendTemplate`, `markAsRead`, `startTyping` and `downloadMedia` work on a bare adapter without a `Chat` instance. VERIFIED(run): a text send and a template send hit the mock server correctly. You still have to feed them Chat SDK `AdapterPostableMessage` or Card objects, though, and the media, interactive and upload primitives are protected.
- **Inbound:** effectively all-or-nothing. You either run the full `Chat` pipeline (state adapter, dedupe, locks, handler registry) or hand-write a `ChatInstance` shim. The shim interface has 25 members, most of them Slack-specific. Even then, statuses and contacts never reach you. The workaround for NestJS if someone insists:
```ts
const tasks: Promise<unknown>[] = [];
const res = await bot.webhooks.whatsapp(toWebRequest(req /* rawBody */), {
  waitUntil: (t) => tasks.push(t), propagateHandlerErrors: true, deduplicate: false });
await Promise.all(tasks);            // our persist+enqueue handler finished -> now ack
// + new Chat({ concurrency: "concurrent", state: createPostgresState({ autoCreateSchema:false }) })
// + parse value.statuses / contacts ourselves from the same raw body anyway
```

## 3. Web chat

- **`@chat-adapter/web` exists** (v4.41.0). It speaks the AI SDK UI message stream protocol. On the server you call `createWebAdapter({ userName, getUser(req) })`, and on the client `useChat` from `@chat-adapter/web/react|vue|svelte`. Thread ids look like `web:{userId}:{conversationId}`.
- **It does not fit OCSO**, for these reasons (VERIFIED(code)):
  - `handleWebhook` wraps `chat.processMessage()` inside `createUIMessageStream({execute})`, so the reply **must be produced inside the HTTP request, by the handler**. That conflicts with "a different process generates the reply".
  - v1 README scope: no file uploads, no cards or buttons, markdown only.
  - History is kept in the Chat SDK state cache.
  - It keeps only `text`, `file` and `data-*` parts of the *last* user message.
- **Recommended pattern:** AI SDK UI (`ai@7.0.109`, `@ai-sdk/react@4.0.112`) talking to our own NestJS endpoints through `DefaultChatTransport`. A custom `ChatTransport` implements `sendMessages` and `reconnectToStream` (VERIFIED(code)).
```ts
const { messages, sendMessage, status, stop } = useChat({
  id: conversationId, resume: true,
  transport: new DefaultChatTransport({
    api: `${OCSO}/v1/webchat/conversations`,               // reconnect default: GET {api}/{chatId}/stream
    headers: () => ({ Authorization: `Bearer ${visitorJwt}` }),
    prepareSendMessagesRequest: ({ id, messages }) =>
      ({ api: `${OCSO}/v1/webchat/conversations/${id}/messages`, body: { message: messages.at(-1) } }), // server is source of truth
  }),
});
```
- **Server side of that pattern:**
  1. POST validates the visitor token.
  2. It maps UIMessage parts (`text`, `file` from a presigned upload URL, `data-*` for structured input) to our Interaction and persists it idempotently on the client message id.
  3. It enqueues a turn.
  4. It returns `UI_MESSAGE_STREAM_HEADERS` SSE, which tails our turn event bus (Redis stream or PG `LISTEN`). Runtime events map to `start`, `text-start/delta/end`, `data-*` and `finish`.
  5. `GET …/{id}/stream` resumes an active turn, or returns 204 if there is none.

## 4. Recommendation: option (b), with Chat SDK as a reference and future operator tooling

- **WhatsApp: build it directly against the Cloud API inside `WhatsAppChannelAdapter`.**
  - The API surface we need is small and stable: one verify, one HMAC, one envelope parser, `/{PNID}/messages`, `/{media-id}` and `/{PNID}/media`.
  - Our adapter must own things Chat SDK does not do:
    - statuses turned into delivery events
    - full multimodal normalization (contacts, structured location, stickers, `context` reply-to, referral)
    - ack only after an idempotent insert keyed on `wamid`
    - routing by `metadata.phone_number_id` across tenants and numbers, with per-number tokens and app secrets
    - capability declaration
    - 24-hour window enforcement
    - outbox semantics
  - Reuse from Chat SDK:
    - Copy its tested edge-case handling (media host allowlist and SSRF guard, BSUID aliasing and `user_id_update`, markdown-to-WhatsApp formatting, 4096 chunking, button and list truncation rules, error-code mapping). Credit it; it is MIT.
    - Use its type definitions as a starting point for our zod schemas.
- **Web chat:** AI SDK UI `useChat` plus our transport and endpoints, as in section 3. This follows the spec ("Vercel … for the chat experience") without importing the Chat SDK object model.
- **Chat SDK use later:** internal and operator channels, such as Slack/Teams escalation, approvals and agent-assist notifications. There the "bot replies in handler" model is correct and its adapter breadth pays off. Keep it behind an `OperatorNotifier` port.
- **Why not option (a):**
  - It gives two domain models: Chat SDK `Message`, `Thread` and `Card` would sit between Meta JSON and our Interaction.
  - It needs a second state store (locks, dedupe, PII history).
  - Its defaults lose data (drop-on-lock, dedupe before persist, 200 before handler).
  - It has no statuses, a single phone number per instance, and a 25 MB media cap.
  - We would need to shim a 25-member `ChatInstance`.
  - The package moves in lockstep with a fast-moving monorepo (v4.x), and so far WhatsApp has been an add-on there rather than the focus. The typed errors, mark-as-read and BSUID work only landed in Aug–Sep 2026.
- **Risks of option (b):**
  - We own Meta API drift: Graph versions ship three to four times a year, and BSUID/username changes are rolling out through 2026. Mitigation: pin `apiVersion` in config, watch the Graph changelog, and keep payload fixtures.
  - We must implement signature, media and SSRF hardening ourselves. Mitigation: port the adapter's `isWhatsAppMediaUrl` and download guard logic.
  - Duplicate outbound sends on ambiguous timeouts, because Meta documents no idempotency key. This is UNVERIFIED as a negative, but the docs don't mention one. Mitigation: an outbox row per send, and don't auto-retry after a request may already have been accepted.

## 5. WhatsApp Cloud API ground truth

**Version.** The current Graph API is **v26.0** (released 2026-07-29). v25.0 was released 2026-02-18, and v20.0 expires 2026-09-24. Base URL: `https://graph.facebook.com/v26.0`. Since v24.0, status webhooks omit the `conversation` object, except inside free-entry-point windows.

**GET verification.** Meta calls `GET <callback>?hub.mode=subscribe&hub.verify_token=<yours>&hub.challenge=<random>`. If the token matches, respond `200` with the raw `hub.challenge`; otherwise respond 4xx.

**POST authenticity.** The header is `X-Hub-Signature-256: sha256=<hex>`, computed as HMAC-SHA256 over the **raw body bytes** using the **App Secret**. Verify it before `JSON.parse`. Optional per-app mTLS is available. Delivery semantics:
- Any non-200 response is retried "with decreasing frequency … for up to 7 days".
- Duplicates are possible.
- Up to 1000 updates can be batched into one POST, but batching is not guaranteed.
- Payloads can be up to 3 MB.
- No ordering guarantee is documented.
- Plan capacity for 3x outbound plus 1x inbound traffic.
```ts
function verifyMeta(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const exp = createHmac("sha256", appSecret).update(raw).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === exp.length && timingSafeEqual(got, exp);
}
```

**Envelope, as a `messages` field example** (this is Meta's image example; I added the BSUID fields `user_id`/`from_user_id` based on the BSUID doc):
```json
{"object":"whatsapp_business_account","entry":[{"id":"<WABA_ID>","changes":[{"field":"messages","value":{
  "messaging_product":"whatsapp",
  "metadata":{"display_phone_number":"15550783881","phone_number_id":"106540352242922"},
  "contacts":[{"profile":{"name":"Sheena Nelson"},"wa_id":"16505551234","user_id":"US.1349…"}],
  "messages":[{"from":"16505551234","from_user_id":"US.1349…","id":"wamid.HBgL…","timestamp":"1744344496",
    "type":"image","image":{"caption":"Taj Mahal","mime_type":"image/jpeg","sha256":"SfIn…","id":"1003383421387256",
    "url":"https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=…"}}]}}]}]}
```

**`messages[]` element by type** (each also has `from`, `id`, `timestamp`, `type`, and an optional `context{from,id}` for replies or `context{forwarded}` for forwards):
- `text`: `{"text":{"body":"hi"}}`
- `image`, `video`, `document`, `sticker`: `{id, mime_type, sha256, caption?, filename? (document), url? (rolling out since 2025-11-12)}`
- `audio`: `{"audio":{"id":"…","mime_type":"audio/ogg; codecs=opus","sha256":"…","voice":true}}`. `voice:true` means a recorded voice note.
- `location`: `{"location":{"latitude":37.48,"longitude":-122.14,"name":"…","address":"…","url":"… (business locations)"}}`
- `contacts`: `{"contacts":[{"name":{"formatted_name":"Barbara J. Johnson","first_name":"Barbara"},"phones":[{"phone":"+1 (415) 555-0829","wa_id":"14125550829","type":"MOBILE"}],"emails":[…],"org":{…},"addresses":[…],"urls":[…],"birthday":"1999-01-23"}]}`
- `interactive`: `{"type":"interactive","context":{"from":"<biz>","id":"wamid.<our msg>"},"interactive":{"type":"button_reply","button_reply":{"id":"cancel-button","title":"Cancel"}}}`. A `list_reply` carries `{id,title,description}`. Template quick replies arrive as `type:"button"` with `{"button":{"payload","text"}}`.
- `reaction`: `{"reaction":{"message_id":"wamid.<target>","emoji":"👍"}}`. **On removal, `emoji` is omitted.**

**`statuses[]`** arrive under the same `field:"messages"`, in `value.statuses`:
```json
{"id":"wamid.HBgL…","status":"sent|delivered|read|failed","timestamp":"1750030073","recipient_id":"16505551234",
 "recipient_user_id":"US.…","pricing":{"billable":true,"pricing_model":"PMP","type":"regular","category":"marketing|utility|authentication|service (UNVERIFIED for non-template)"},
 "errors":[{"code":131049,"title":"…","message":"…","error_data":{"details":"…"}}]}
```
- `errors` appears only when `status` is `failed`.
- "delivered" may be skipped when a message is delivered and read at the same moment.
- Store status as a monotonic max (sent < delivered < read), with `failed` terminal.

**Identity (BSUID).**
- BSUIDs have appeared in webhooks since early April 2026. Sending to a BSUID via `"recipient"` has been supported since July 2026.
- If a user adopts a username and hasn't interacted with the business number in the last 30 days, `from`/`wa_id` (the phone number) **may be absent**. Only `from_user_id` / `contacts[].user_id` is guaranteed.
- Format: `US.13491208655302741918`, or `US.ENT.…` for a parent BSUID.
- The BSUID rotates when the user changes phone number. Subscribe to the `user_id_update` field.
- **Our `ChannelIdentity` key should therefore be (phone_number_id, BSUID), with the phone number as an optional attribute.**

**Media.**
1. `GET /v26.0/{media-id}` (Bearer token) returns `{messaging_product,url,mime_type,sha256,file_size,id}`.
2. `GET <url>` with `Authorization: Bearer <token>` returns the bytes. **The URL expires in 5 minutes.**
- Inbound media IDs are valid for **7 days**; uploaded IDs for 30 days. Copy media to our object storage at ingest and verify `sha256`.
- Upload with `POST /{PNID}/media` (multipart `file`, `type`, `messaging_product=whatsapp`).
- Size limits: image 5 MB (JPEG/PNG), audio 16 MB, video 16 MB (MP4 H.264+AAC, 3GP), document 100 MB, sticker 100 KB static or 500 KB animated.

**Sending.** Call `POST /v26.0/{PNID}/messages` with a Bearer token and a JSON body. The response is `{"messaging_product":"whatsapp","contacts":[{"input","wa_id"}],"messages":[{"id":"wamid…","message_status"?}]}`.
```json
{"messaging_product":"whatsapp","recipient_type":"individual","to":"16505551234","type":"text","text":{"preview_url":false,"body":"…≤4096"}}
{"messaging_product":"whatsapp","recipient_type":"individual","recipient":"US.1349…","type":"image","image":{"id":"1479537139650973","caption":"≤1024"}}
{"…":"…","type":"document","document":{"link":"https://…/invoice.pdf","filename":"invoice.pdf"}}
{"…":"…","type":"interactive","interactive":{"type":"button","body":{"text":"≤1024"},"footer":{"text":"≤60"},
  "action":{"buttons":[{"type":"reply","reply":{"id":"≤256 chars","title":"≤20 chars"}}]}}}
{"…":"…","type":"template","template":{"name":"payment_reminder","language":{"code":"en_US"},
  "components":[{"type":"body","parameters":[{"type":"text","text":"$50"}]}]}}
{"messaging_product":"whatsapp","status":"read","message_id":"wamid.<inbound>","typing_indicator":{"type":"text"}}
```
- Send media by `id` (recommended) or by `link`.
- Reply buttons: at most 3. Lists and `cta_url` are also available.
- The last request above marks a message read and shows a typing indicator for up to 25 s.
- Add `"context":{"message_id":"wamid…"}` to quote-reply.
- When sending, `to` takes precedence over `recipient`.

**24-hour customer service window and pricing.**
- The window opens or refreshes whenever the user messages or calls. Inside it, any non-template message is allowed and is **free**.
- Outside it, you can send **only approved templates**. Otherwise you get error `131047` ("More than 24 hours have passed…").
- Billing has been per-message since 2025-07-01. Only delivered templates are charged (marketing, utility, authentication). Utility templates sent inside an open window are free.
- Click-to-WhatsApp ads and Page button entry points open a 72-hour free-entry-point window.
- Collections and outreach flows therefore need a template path and a per-conversation `window_expires_at`.

**Limits and errors.**
- Throughput is 80 msg/s per number by default, auto-upgradable to 1000. Exceeding it returns `130429`. A number shared with the Business App is fixed at 20 msg/s.
- Pair rate limit `131056` ("too many messages … to the same recipient … in a short period"). Community sources put it at about 1 message per 6 s with bursts; that number is UNVERIFIED on Meta's docs.
- Messaging limits apply at the business-portfolio level: 250, 2k, 10k, 100k or unlimited unique users per rolling 24 h, for messages outside the window.
- Other error codes:
  - `131026`: undeliverable
  - `131049`: ecosystem-engagement block
  - `131051`: unsupported type
  - `131052` / `131053`: media download or upload failed
  - `132000` / `132001`: template parameters or template missing
  - `190`: token expired
  - `4` / `80007`: API rate limits
  - `368`: WABA restricted

**Idempotency.**
- **Inbound:** dedupe on `messages[].id` (the `wamid`, via a unique index), and on `(statuses[].id, status)` for statuses. Always return 200 only *after* the raw event is durably stored in our inbox table, then normalize asynchronously.
- **Outbound:** Meta's docs mention no idempotency key (UNVERIFIED as a negative). Store the returned `wamid` on the outbox row, and match status webhooks back through it.

**Sources:**
- npm: `chat`, `@chat-adapter/*`, `ai`, `@ai-sdk/react`, `@nestjs/core` (versions checked 2026-09-22)
- github.com/vercel/chat
- chat-sdk.dev/docs (bundled as `node_modules/chat/docs`)
- developers.facebook.com:
  - /docs/graph-api/changelog
  - /documentation/business-messaging/whatsapp/: webhooks/overview, webhooks/create-webhook-endpoint, webhooks/reference/messages/{image,audio,location,contacts,interactive,reaction,status}, business-scoped-user-ids, business-phone-numbers/media, messages/send-messages, messages/image-messages, messages/interactive-reply-buttons-messages, typing-indicators, throughput, messaging-limits, pricing, support/error-codes
- docs.nestjs.com/faq/raw-body
