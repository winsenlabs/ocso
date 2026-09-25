# Channels and Multimodal Interactions

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [guides/channels/README.md](../../guides/channels/README.md), [routing.md](../../concepts/routing.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

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
- The window is computed from the adapter's `sessionWindowHours` and the customer's last message on that channel across their conversations; the conversation detail exposes `sessionWindow: { open, closesAt, hours }` (null without a window). A free-form human reply after the window is refused with 409 `session_window_closed` before anything is persisted or sent; a reply already queued that the adapter (or the provider, Twilio 63016 / Meta 131047) refuses as `requiresTemplate` is marked failed with the same code. A template message is one `STRUCTURED` part (`schema: ocso.message_template`; the legacy `ocso.whatsapp_template` is still read) whose `fallbackText` is the filled text (timeline, customer history, the agent's context) and whose data holds the template id/name/language/category, the values and the definition; delivery sends it with `adapter.sendTemplate`. `GET /v1/channels/:id/templates` (provider list cached ~5 minutes per API instance, `?refresh=true`, merged with the `message_templates` rows OCSO submitted — a row checked after the cached list wins the status), `POST …/templates`, `GET|DELETE …/templates/:templateId`; the worker's leader polls templates in review every 3 minutes, records changes (audited), and emits `message_template.status_changed` (in-app notice for the submitter) and `config.changed`.
- Routing (PM/research/11 §5, ADR-031): a channel no longer names an agent. `channels.router_id` points at a router; ingress (`admitConversation`) keeps one open conversation per (customer, channel) (`conversations_open_channel_uq`, migration 0025), decides pass-through routers synchronously (the pre-routing behaviour, migrated for every channel that had an agent) and opens routers with steps in `ROUTING` (no agent yet) for the worker's `conversation.route` consumer, which asks (CHOICES), classifies (the step's model profile, structured `{label, confidence, followUp}`), falls back or times out (`routing-timeout` leader task, 60 s) and then hands the conversation to the chosen queue's agent (`ROUTE_COMPLETE`), which answers every customer message since routing started. A customer returning after the router's `returning.askAfter` gap is asked continue-or-new first; "new" resolves the old conversation (`CUSTOMER_STARTED_NEW`) and opens a new one carrying the messages that brought them back. Router questions are `OUTBOUND` interactions with actor `ROUTER`, delivered like any reply; outside the session window a per-channel approved template mapped in the router (`MessageSpec.templates[channelId]`, no variables) is sent instead, else delivery records `session_window_closed`. The CHOICES part is a `STRUCTURED` part (`schema: ocso.choices`, numbered `fallbackText`); the channels' `capabilities.choices` decide native rendering (docs/plugins/channels.md). The web chat shows ROUTER messages as the assistant (no name) with one button per option; a tap is sent as the option's label. The chosen queue's agent must answer (LIVE with a model profile): routing prefers the decided queue, then the fallback, and when neither agent answers the customer is handed to a person on the queue at once; when neither queue has an agent at all the conversation stays ROUTING (a `system.routing_blocked` timeline entry, visible to the Leads the router reaches) and routing retries on every customer message and every minute. The timeout counts from the router's last question, and an answer stored before the sweep wins over the timeout. Conversations already under way never depend on the channel's router: disabling or detaching it stops new conversations only, which are rejected as `no_router` (logged, and recorded in the audit log as `conversation.inbound_rejected` without the message text), while customers mid-conversation keep reaching their agent or person.
- Routing under maker–checker (PM/research/11 §4, §5.7; wave 2, ADR-031 amendment). Routers, queues and SLA policies are approval kinds checked with `approvals.check.routing` (Heads). A router is built as a **draft** (definition, name, and — while it is a draft — its channels change directly and route nothing); **Save as new version** freezes the draft; **Activate vN** (the newest version only; an older one is restored as the draft and frozen again) and resuming a disabled router are always a proposal, and so is deleting (refused while channels are attached or conversations are being routed). Once approved, renaming and attaching channels are proposals; **disabling** and **detaching** a channel are stops (immediate, never locked by an open proposal). Activation validates that every queue the version routes to is approved and its agent LIVE, that every CLASSIFY model profile is approved, and that per-channel templates belong to their channel and are approved; a reference whose own approval is still open is shown to the checker as a warning and blocks until it lands. A queue is created as a draft; its first approval (**Submit** on the Queues page, action CREATE) is what lets routers use it; afterwards — or while live routing already reaches it — every change (agent, attributes, hours, SLA policy, pickup settings, added teams or transfer targets) is a proposal carrying a delta, while removing a transfer target and unlinking your own team apply at once. SLA policies follow the same draft → CREATE → UPDATE rule. The builder (`/routers/[id]`) edits ASK / CLASSIFY / KNOWN steps, rules over queue attributes (`language=ta, product=sales|loans`; **Rules from queue attributes** writes one per attribute queue), the fallback queue, returning customers (value + hours/days/months) and the timeout; **Create template for <channel>** drafts a message template from a router message on that channel, maps it into the message, and opens the template's approval; the simulate panel shows the decision trace of the draft or a version. The workspace shows a **Routing** card (router and version, outcome, deciding rule, attributes, answers), a Routing state chip and inbox filter; the transfer dialog names the receiving queue's agent; an agent's Channels tab is the derived **Reached through** list (channel → router → queue); the channel screen shows its router.
- Message templates under maker–checker (PM/research/11 §4; kind `message_template`, checked with `approvals.check.channels`). `POST /v1/channels/:id/templates` saves a **draft** in OCSO only (status DRAFT, no provider id; `problems` block its submission, `warnings` are advisory) and `PUT …/templates/drafts/:recordId` edits it while no proposal waits. `POST …/drafts/:recordId/submit` (or `approval` on the create) is a CREATE proposal; its activation is DEFERRED: after approval the worker re-validates, re-checks both hashes and only then calls `createTemplate` — never before approval, never twice (a retry first looks the template up by name and language). A provider refusal blocks the proposal and leaves the draft a draft. Deleting (`message_templates.delete`, Head) is a DELETE proposal finished at the provider by the worker (a draft the provider never saw goes at approval); a template made in the provider's console is recorded in OCSO (origin PROVIDER) when a deletion is asked, so the proposal has an object — such records never count as OCSO-approved content. Migration 0027: `provider_template_id` nullable, `origin`.
