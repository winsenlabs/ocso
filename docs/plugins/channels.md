# Channel adapters

A channel adapter connects OCSO to one customer messaging transport. It verifies and parses what the
provider sends, renders OCSO's canonical message parts into the provider's format, and sends them. It
also describes itself: everything the API and the web app know about a channel kind — the "Add
channel" form, labels, the badge in the inbox, setup steps, public paths, template wording, how its
customer identities are shown — comes from the adapter's descriptor. The core does everything else:
routing the webhook, storing the message exactly once, resolving the customer, running the agent,
retrying delivery. Core code never names a kind.

Shipped adapters, all in `packages/channels/src/`:

| Kind | Directory | Transport |
|---|---|---|
| `TWILIO_WHATSAPP` | `twilio-whatsapp/` | WhatsApp through Twilio Programmable Messaging |
| `WHATSAPP` | `whatsapp/` | WhatsApp Cloud API, called directly (Meta) |
| `WEBCHAT` | `webchat/` | OCSO's own embeddable widget |

The package README ([packages/channels/README.md](../../packages/channels/README.md)) documents each
adapter's provider details. The operator setup is in
[docs/operations/setup-guide.md §3](../operations/setup-guide.md#3-channels-tech-a-head-approves).

## The contract

Three files in `packages/channels/src/contract/`, all exported from `@ocso/channels`:

- `types.ts` — `ChannelAdapter` and the transport types;
- `descriptor.ts` — `ChannelKind`, `ChannelKindDescriptor` and what the registry derives from it;
- `embed.ts` — the public widget protocol of embeddable kinds.

```ts
/** Open: a kind exists when its adapter is registered. Upper snake case (CHANNEL_KIND_PATTERN). */
export type ChannelKind = string;

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Everything the API and web app know about this kind (form, labels, mark, setup steps, public paths). */
  describe(): ChannelKindDescriptor;
  capabilities(config: ChannelRuntimeConfig): ChannelCapabilities;
  /** How staff see a customer identity this channel created, in lists; null for identity kinds that are not yours. */
  displayIdentity?(identityKind: string, value: string): string | null;
  /** The public widget protocol; required exactly when the descriptor is `embeddable`. */
  readonly embed?: EmbeddedChat | undefined;
  /** Validate admin-entered settings/secrets; returns human-readable problems. */
  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[];
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult;
  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope;
  /** Reply for an accepted webhook; when absent the API answers with a JSON ingest summary. */
  webhookAcknowledgement?(): WebhookAcknowledgement;
  fetchMedia(ref: MediaRef, config: ChannelRuntimeConfig): Promise<FetchedMedia>;
  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[];
  send(target: OutboundTarget, message: RenderedOutbound, config: ChannelRuntimeConfig, media: OutboundMediaResolver): Promise<SendResult>;
  /** Read-only check of the stored credentials against the provider; never sends a message. */
  checkConnection?(config: ChannelRuntimeConfig): Promise<ConnectionCheckResult>;
  // Message templates, optional as a set: listTemplates, sendTemplate, createTemplate, templateStatus, deleteTemplate.
}

export interface ChannelKindDescriptor {
  kind: ChannelKind;
  label: string;                               // admin screens: "WhatsApp — Twilio"
  description: string;
  mark: ChannelMark;                           // { code: 'WA', name: 'WhatsApp', tone?: 'wa' } — the inbox badge
  settingsSchema: Record<string, unknown>;     // JSON Schema (input shape) of the non-secret settings
  secrets: ChannelSecretField[];
  identitySetting?: ChannelIdentitySetting;    // { label: 'sender', keys: ['from', 'messagingServiceSid'] }
  setupSteps: readonly string[];               // what the admin does in the provider's console after saving
  inboundWebhook: boolean;                     // provider calls /channels/<webhookSegment>/<publicKey>/webhook
  webhookSegment?: string;                     // lower-case a-z0-9-; defaults to the kind in kebab case
  webhookEvents?: string;                      // "messages, delivery statuses", for the Webhooks list
  embeddable: boolean;                         // served by OCSO's widget; requires `embed`
  templates?: ChannelTemplateTerms;            // { reviewer, placeholderScope, mediaHeaderUnsupported? }
}
```

`GET /v1/channels/kinds` returns `registry.describeAll()`: each descriptor plus two flags the
registry derives from the adapter, `connectionCheck` (it implements `checkConnection`) and
`messageTemplates` (it implements `listTemplates`, `createTemplate` and `sendTemplate`).

Other types you will use:

- `ChannelRuntimeConfig`: one channel instance, with `settings` and **already resolved** `secrets`, plus
  its public `webhookUrl` when the kind has one.
- `ChannelCapabilities`: part types in and out, text length limit, `markdown` (`none`, `basic` — emphasis
  and lists, converted by the adapter — or `commonmark`), media size and MIME allowlists,
  `sessionWindowHours` (WhatsApp: 24, others `null`), the `identityKinds` the channel can address, and
  optionally `choices: { buttons, list }` — how many options the channel can show as native buttons and
  as a list picker (see "Choice questions" below).
- `InboundEnvelope`: `messages`, delivery `statuses`, optional `identityUpdates` and `templateUpdates`,
  and an `ignored` count.
- `SendResult`: `{ ok: true, externalMessageId }`, or a failure with `errorCode`, `retriable` and
  optionally `requiresTemplate`.
- `ChannelAdapterDeps`: `{ fetch: ChannelFetch; now }`, what the composition root gives your factory.

The adapter contract says it plainly: adapters "own transport concerns only … They never run the agent
loop and never touch the database."

## How one is registered

A channel package contributes adapter factories to the composition root. The first-party ones are one
entry of `FIRST_PARTY_PLUGINS` in `packages/bootstrap/src/first-party.ts`:

```ts
{ name: '@ocso/channels', channels: [createTwilioWhatsAppAdapter, createWhatsAppAdapter, createWebChatAdapter] },
```

`createChannelRegistry` (`packages/bootstrap/src/channels.ts`) calls each factory with the host's
`{ fetch, now }` and registers the result; the api, the worker and the seed all build their registry
there. The order is the order of the "Add channel" list.

`ChannelRegistry.register` checks the adapter once, at start-up, and refuses:

- a kind that is not upper snake case, or that is already registered;
- a descriptor whose `kind` differs from the adapter's, or whose mark code is not 1–3 letters/digits;
- `embeddable` without `embed` hooks, or `embed` hooks on a non-embeddable kind;
- `templates` terms without the template methods, or template methods without `templates` terms;
- a duplicate or malformed webhook segment.

Nothing else lists kinds: the database column is `text`, the API validates `kind` against the registry,
and the web app parses kinds as plain strings.

## Egress: the injected fetch

Adapters reach the network only through `deps.fetch`. The composition root passes the SSRF-guarded
channel egress (`createChannelEgress` in `packages/application/src/channels/egress.ts`, built on the
MCP guard, ADR-021): public https hosts only; private, loopback and metadata addresses are refused
unless a Tech admin allowlisted the host in deployment settings (the same list INTERNAL MCP
connections use, re-read every 10 s; plain http is allowed only for those hosts). Responses are capped
at 101 MB. A factory called without `fetch` gets `NO_NETWORK`, which rejects every call — an adapter
never falls back to the global `fetch`. Tests pass a stub.

Keep your own host checks for media URLs a provider hands you (`common/safe-download.ts`): the guard
stops the internal network, your allowlist stops credentials going to the wrong public host.

## What the core does for you

**Routing to an agent.** `channel → router → queue → agent` (PM/research/11 §5, ADR-031). A channel
points at a router (`channels.router_id`); the router's active version decides the queue — at once for a
pass-through router, or after asking the customer (menus), classifying their messages with a model, or
both — and the queue's one AI agent answers. Your adapter does nothing for this: it only delivers the
router's questions (below) and normalizes the replies. A channel with no active router rejects inbound
messages as `no_router`, logged loudly with the reason. `channels.default_agent_id` and `agent_channels`
are deprecated, no longer read or written, and are dropped in a later release.

**Choice questions (CHOICES).** A router asks with one outbound part: `STRUCTURED` with
`schema: 'ocso.choices'` and `data: { text, options: [{ id, label }] }` (`CHOICES_SCHEMA`, `choicesOf`
from `@ocso/domain`). Its `fallbackText` is the numbered text, so a renderer that knows nothing about
choices still sends something the customer can answer ("2" or "Loans"). To render natively, declare
`capabilities.choices` and, in `render`, turn the part into your buttons or list; keep each option's
`id` as the button/row id so a tap can be matched exactly. `choicesPresentation(data, capabilities)`
says which form fits and `renderChoicesAsText(data)` gives the numbered text. As built: WhatsApp
(Meta) sends up to 3 options as reply buttons and up to 10 as a list message (falling back to text when
cut titles would collide), Twilio sends the numbered text (interactive messages need Content Templates
there), and the web chat widget draws buttons. Inbound, normalize a tap to a `STRUCTURED` reply whose
`data.id` is the option id and whose `fallbackText` is its title (the WhatsApp adapters already produce
`button_reply` / `list_reply` parts this way); typed answers need nothing — the router matches the
number, the label, the value or a synonym. Core never names your kind for any of this.

**Webhook routing.** Every inbound-webhook kind shares one route in
`apps/api/src/modules/channels/channel-webhook.controller.ts`:

```
GET  /channels/:segment/:publicKey/webhook   subscription handshakes (e.g. Meta's verify-token challenge)
POST /channels/:segment/:publicKey/webhook   messages and delivery statuses
```

The registry maps the segment to a kind, the channel is loaded by its public key (404 unless that kind
owns it), and its secrets are resolved from the SecretStore. The web app proxies `/channels/*` to the
api, so this works behind the single published port. The routes are public by design and are pinned in
`apps/api/test/unit/route-access.test.ts`; authenticity is your `verifyRequest`. The API keeps the raw
body for HMAC checks and passes `req.url` as the public origin plus the path exactly as received, for
URL-bound signatures such as Twilio's.

**Verify, then persist, then acknowledge.** The controller calls `verifyRequest`, then `parseInbound`,
then hands the envelope to `IngressService`
(`packages/application/src/conversations/ingress.ts`). For each message it takes an advisory lock on
`(channel, externalMessageId)`, drops duplicates, resolves or creates the customer from
`identityKind`/`identityValue` and the alternates, writes the interaction, and queues the AI turn and
one `media.fetch` job per pending media part. Only then does the API answer, with your
`webhookAcknowledgement()` or a JSON summary. A provider that retries after a timeout gets a
duplicate, not a second message.

**Delivery statuses, identity changes, template reviews.** Statuses are applied so they never move
backwards. `identityUpdates` re-link an existing customer identity instead of creating a new customer.
`templateUpdates` record provider-pushed template review results.

**Media.** A worker runs `fetchMedia` for each pending part, re-checks the bytes, and stores them in
the BlobStore. Throw `ChannelMediaError`: a `rejected` reason (too large, wrong type, bad host,
checksum) marks the part `REJECTED`; a retriable error retries the job.

**Outbound.** `DeliveryService` (`packages/agent-runtime/src/delivery/delivery.ts`) filters the
message to customer-safe parts your capabilities accept (tool results and internal notes never reach
`render`), picks the customer's identity in your `identityKinds` order, calls `render`, then `send`
per payload. A `retriable` failure is retried by the queue with exponential backoff, up to 8 attempts.
`requiresTemplate` marks the reply failed as `session_window_closed`.

**The prompt.** The compiler's channel block (`<ocso_channel>`) is generated from your capabilities:
`maxTextLength`, `markdown` and the media in `outboundParts`. Business prompts keep only their own style
rules in `channel_constraints`.

**Administration.** The "Add channel" form in `apps/web/components/connections/channels/` renders the
settings from `settingsSchema` (titles, descriptions and defaults from the zod `.meta()` and
`.default()`), and one write-only field per entry in `secrets`. A secret marked `generate: 'server'` is
generated by OCSO when left empty; `generate: 'client'` gets a Generate button and is shown once more
beside the setup steps after saving. When a channel is set Active, the service runs `validateConfig`.
Problems written as `settings.<path>: message` or `secrets.<key>: message` show under the matching
field. Secrets go to the SecretStore as `CHANNEL_TOKEN` references and are never returned. If you
implement `checkConnection`, the channel gets a **Test connection** button. After saving, the form shows
the webhook URL (the API derives `webhookPath` from your segment) and your `setupSteps`. The channel
card shows your `mark`, `label` and `identitySetting`; the Webhooks list shows your `webhookEvents`.

**The workspace.** Inbox rows, the conversation header, agents and analytics show your `mark` (code,
network name, tone). `GET /v1/channels/kinds` is readable by every area that displays channels
(`channels.read`, `conversations.read`, `conversations.read_team` or `agents.read`): it is static
plugin metadata, never instances or secrets.

**Session windows and message templates.** Declare `sessionWindowHours`; the conversation detail's
`sessionWindow` (`{ open, closesAt, hours }`) and the 409 `session_window_closed` on free-form replies
use it. The helper `withinSessionWindow` in `contract/render-policy.ts` tells your `send` whether a
free-form send is allowed. Implement the template methods and describe `templates` to get the
Message templates page (`/templates`), the composer's Template mode, the review poller and in-app review
notices; `templates.reviewer` names who approves them in the UI copy.

**Identity display.** Lists mask customer identities by shape (phones, emails, long ids). Implement
`displayIdentity` for identity kinds you want shown differently; web chat shows anonymous visitors as
`web · sess 8f2a`.

**Embeddable kinds.** `embeddable: true` plus `embed` hooks put the kind behind OCSO's widget: the
script `/ocso-webchat.js` (`data-key=<publicKey>`), the page `/chat/<publicKey>` (the channel's
`embedPath`) and the public API `/public/webchat/<publicKey>/*`. The API owns origins, uploads, history,
the SSE stream and CSAT; your hooks own the rest:

```ts
export interface EmbeddedChat {
  widgetConfig(config): EmbedWidgetConfig;                   // allowedOrigins, branding, attachment limit, hostIdentity
  openSession(config, { visitorToken?, hostToken? }): EmbedSession;
  identify(config, bearerToken: string | undefined): EmbedVisitor;
  attachmentKeyPrefix(config, visitor): string;              // uploads live under it; parseInbound rejects other keys
}
```

## Skeleton

The shape of every shipped adapter: a class, a factory with injectable deps, and small modules for
config, descriptor, capabilities, verification, inbound parsing, rendering and sending.

```ts
// packages/channels/src/acme/adapter.ts
export class AcmeChannelAdapter implements ChannelAdapter {
  readonly kind = 'ACME' as const;

  constructor(private readonly deps: ChannelAdapterDeps) {}

  describe(): ChannelKindDescriptor { return ACME_DESCRIPTOR; }
  capabilities(): ChannelCapabilities { return ACME_CAPABILITIES; }
  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    return validateAcmeConfig(settings, secrets); // "settings.x: …" / "secrets.y: …", never echo values
  }
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult {
    return verifyAcmeSignature(req, config.secrets['signingSecret']); // constant-time compare
  }
  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope {
    return parseAcmeWebhook(req.rawBody, { now: this.deps.now });
  }
  fetchMedia(ref: MediaRef, config: ChannelRuntimeConfig): Promise<FetchedMedia> {
    return fetchAcmeMedia(ref, { config, fetch: this.deps.fetch, capabilities: this.capabilities() });
  }
  render(parts: readonly InteractionPart[]): RenderedOutbound[] {
    return renderAcmeParts(parts, this.capabilities());
  }
  send(target: OutboundTarget, message: RenderedOutbound, config: ChannelRuntimeConfig, media: OutboundMediaResolver): Promise<SendResult> {
    return sendAcmeMessage(target, message, { config, fetch: this.deps.fetch, media });
  }
}

/** `deps.fetch` is the host's guarded egress; without it the adapter has no network. */
export function createAcmeAdapter(deps: Partial<ChannelAdapterDeps> = {}): AcmeChannelAdapter {
  return new AcmeChannelAdapter({ fetch: deps.fetch ?? NO_NETWORK, now: deps.now ?? (() => new Date()) });
}
```

[add-a-channel.md](add-a-channel.md) fills this in for a Telegram-shaped channel.

## Tests to copy

All channel tests run offline with a fake `fetch` and provider-shaped fixtures.

- `packages/channels/test/adapters-contract.test.ts`: the shared contract. Add your adapter to the
  `adapters` array. It checks registration, that tool results never render, consistent media limits,
  and that your own valid config passes `validateConfig`.
- `packages/channels/test/registry.test.ts`: what the registry refuses, a third-party kind registered
  without any core change, the descriptors the web app renders, embed hooks and identity display.
- `packages/channels/test/twilio-*.test.ts` and `whatsapp-*.test.ts`: one file per concern (config,
  signature, inbound, media, render, send, templates). `test/helpers/` builds configs and signed
  requests; `test/fixtures/` holds recorded-shape payloads.
- `apps/api/test/int/twilio-whatsapp.int.test.ts`: the real API against a local provider stub. It
  covers the generic webhook route, signature checks over the public URL, persist-once ingress, the
  acknowledgement, the connection check, and the egress guard (a stub host that is not allowlisted is
  refused).
- `apps/api/test/int/message-templates.int.test.ts`: templates end to end against `twilio-stub.ts`.
- `apps/api/test/int/channels-admin.int.test.ts`: channel administration, kinds (and who may read
  them), public paths and secrets.

## Limits today

- Kinds are compiled in: a channel package is added to `FIRST_PARTY_PLUGINS` and the build is rebuilt.
  The plugin SDK and a config-driven loader come later (docs/plugins/README.md).
- The widget's public API keeps its historical path, `/public/webchat/<publicKey>/*`, for every
  embeddable kind (the live widget and embeds depend on it).
- The template draft rules (`checkTemplateDraft` in `packages/domain/src/templates/`: categories,
  authentication templates, review heuristics) follow WhatsApp, today's only template network. A kind
  with different rules can refuse a draft from `createTemplate` with a `TemplateProviderError`.
- Audit rows written before the rename keep their `whatsapp_template.*` actions; new rows use
  `message_template.*`. Template messages stored as `ocso.whatsapp_template` parts are still read and
  delivered; new ones are `ocso.message_template`.
- The WhatsApp list message's opening button reads "Choose" (Meta requires one); router messages carry no
  per-language button text yet.
- Outbound sends are at-least-once. If the provider has no idempotency key, a crash between the provider
  accepting a message and OCSO recording its id can send a duplicate (ADR-007).
