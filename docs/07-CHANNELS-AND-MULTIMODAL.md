# Channels and Multimodal Interactions

## 1. Canonical interaction model

Channels must translate into a channel-neutral OCSO interaction.

```ts
type InteractionPart =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | DocumentPart
  | LocationPart
  | ContactPart
  | StructuredPart;
```

One interaction may contain many parts.

## 2. Channel adapter responsibilities

A `ChannelAdapter` owns:
- webhook/request verification
- external identity extraction
- inbound normalization
- media retrieval/reference handling
- deduplication/idempotency keys
- outbound rendering
- delivery acknowledgements/status
- channel capability declaration
- channel-specific limits

It does not own the agent loop.

## 3. WhatsApp

WhatsApp is a first-class initial channel.

Inbound requests arrive from the configured WhatsApp integration. The adapter must:
- verify authenticity
- map sender identity to `CustomerIdentity`
- persist inbound interactions before processing
- handle media safely
- avoid exposing tool/internal events to the customer
- support delivery status callbacks where applicable

## 4. Web chat

Web chat should use Vercel Chat SDK where it provides useful transport/UI primitives, but preserve OCSO's canonical event model.

The CS workspace is separate from customer web chat even if both are Next.js surfaces.

## 5. Rendering policy

Agent runtime emits a rich internal event stream.

Each channel renderer decides what can be shown:
- customer text
- media
- structured cards where supported
- citations where appropriate

Internal-only events such as raw tool traces, secrets, policy metadata or hidden agent state must not leak to customer channels.

## 6. Multimodal storage

Store:
- metadata and references in PostgreSQL
- larger binary payloads in S3-compatible blob storage

Apply:
- MIME/type validation
- size limits
- signed access
- malware/content safety hooks where required
- retention policy

## 7. Future voice

Voice should be implemented as another channel adapter plus streaming media capabilities, not by rewriting the core conversation model.

## Implementation notes (as built)

- Web chat is built on AI SDK UI (`useChat` with an OCSO transport over the public web chat API) inside an iframe served at `/chat/<channel key>` and embedded with `<script src="…/ocso-webchat.js" data-key="…">`; Chat SDK is deferred (ADR-007). The page's CSP `frame-ancestors` and the API's Origin check come from the channel's `allowedOrigins`.
- Channel kinds describe their settings (JSON Schema) and secrets for the admin form (`GET /v1/channels/kinds`); secrets are write-only.
- Media: inbound bytes are fetched by the worker (WhatsApp: allowlisted Meta hosts only, redirects re-checked), size/MIME-checked and stored in the blob store; staff reply attachments are uploaded per conversation and replies may only reference those keys. Retention can expire stored bytes (status `EXPIRED`, docs/15 notes).
- Channel kinds are plugins: the API accepts a kind only when an adapter is registered (`ChannelRegistry`), the channel's `webhookPath` comes from the adapter descriptor's `webhookSegment`, and every inbound-webhook kind is served by one route, `/channels/<segment>/<key>/webhook` (`whatsapp` = Meta Cloud API, `twilio-whatsapp` = Twilio). Adapters with a read-only credential check expose it as `POST /v1/channels/:id/test`.
- WhatsApp via Twilio (`TWILIO_WHATSAPP`, PM/research/06) sits beside the direct Meta adapter and shares its formatter and the `whatsapp_phone` identity kind (Twilio's 2026 `ExternalUserId` BSUID is kept as a `whatsapp_bsuid` alternate). Webhooks are `X-Twilio-Signature` (HMAC-SHA1 of `OCSO_PUBLIC_URL` origin + path/query as received + sorted form params, with/without port like twilio-node) and are answered with empty TwiML; one URL takes inbound messages and status callbacks (idempotent on MessageSid; statuses never move backwards). Sends are form posts to the Messages API with a short-lived signed blob URL as `MediaUrl` (one media per message, captions only on images), 1,600-character bodies, the per-message `StatusCallback`, and Content Templates (`ContentSid` + `ContentVariables`) outside the 24-hour window (`requiresTemplate`, as with Meta). Media downloads send credentials only to the API host and follow redirects manually, without credentials, to Twilio's CDN/S3 hosts. Delivery picks the customer identity the channel can address (`capabilities.identityKinds`).
- WhatsApp message templates and the 24-hour window (§3; PM/research/10). The adapter contract has optional template methods — `listTemplates`, `sendTemplate` (normalized: template id, language, values keyed by variable), `createTemplate` (create + submit for WhatsApp approval, all or nothing), `templateStatus`, `deleteTemplate` — over a channel-neutral model in `@ocso/domain` (`MessageTemplate`: category, normalized status `DRAFT|PENDING|APPROVED|REJECTED|PAUSED|DISABLED`, rejection reason, header/body/footer/buttons, variables with examples, `unsupportedReason`). Twilio uses the Content API with the channel's credentials (`ContentAndApprovals` for the list, `Content` + `ApprovalRequests/whatsapp` to create/submit, `contentApiBaseUrl` setting for tests/proxies); variables are global (`"1"`). Meta uses `/{WABA}/message_templates` and needs the channel's `businessAccountId` (the descriptor and the list's `templates_not_configured` problem say so); variables are per component (`body.1`, `header.1`, `button.0.1`, named parameters as `body.<name>`), media headers take a link at send time, and `message_template_status_update` webhooks become `templateUpdates` on the inbound envelope. Only `APPROVED` templates with supported components are sendable.
- The window is computed from the adapter's `sessionWindowHours` and the customer's last message on that channel across their conversations; the conversation detail exposes `whatsappWindow: { open, closesAt }` (null without a window). A free-form human reply after the window is refused with 409 `session_window_closed` before anything is persisted or sent; a reply already queued that the adapter (or the provider, Twilio 63016 / Meta 131047) refuses as `requiresTemplate` is marked failed with the same code. A template message is one `STRUCTURED` part (`schema: ocso.whatsapp_template`) whose `fallbackText` is the filled text (timeline, customer history, the agent's context) and whose data holds the template id/name/language/category, the values and the definition; delivery sends it with `adapter.sendTemplate`. `GET /v1/channels/:id/templates` (provider list cached ~5 minutes per API instance, `?refresh=true`, merged with the `whatsapp_templates` rows OCSO submitted — a row checked after the cached list wins the status), `POST …/templates`, `GET|DELETE …/templates/:templateId`; the worker's leader polls templates in review every 3 minutes, records changes (audited), and emits `whatsapp_template.status_changed` (in-app notice for the submitter) and `config.changed`.
