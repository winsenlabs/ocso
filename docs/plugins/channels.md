# Channel adapters

A channel adapter connects OCSO to one customer messaging transport. It verifies and parses what the
provider sends, renders OCSO's canonical message parts into the provider's format, and sends them. The
core does everything else: routing the webhook, storing the message exactly once, resolving the
customer, running the agent, retrying delivery.

Shipped adapters, all in `packages/channels/src/`:

| Kind | Directory | Transport |
|---|---|---|
| `TWILIO_WHATSAPP` | `twilio-whatsapp/` | WhatsApp through Twilio Programmable Messaging |
| `WHATSAPP` | `whatsapp/` | WhatsApp Cloud API, called directly (Meta) |
| `WEBCHAT` | `webchat/` | OCSO's own embeddable widget |

The package README ([packages/channels/README.md](../../packages/channels/README.md)) documents each
adapter's provider details. The operator setup is in
[docs/operations/setup-guide.md §3](../operations/setup-guide.md#3-channels-tech-admin).

## The contract

`packages/channels/src/contract/types.ts`, trimmed:

```ts
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Form description for channel administration. */
  describe?(): ChannelKindDescriptor;
  capabilities(config: ChannelRuntimeConfig): ChannelCapabilities;
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
}

/** What the "Add channel" form needs to know about a channel kind. */
export interface ChannelKindDescriptor {
  kind: ChannelKind;
  label: string;
  description: string;
  /** JSON Schema (input shape) of the non-secret settings. */
  settingsSchema: Record<string, unknown>;
  secrets: ChannelSecretField[];
  /** Provider calls OCSO at `/channels/<webhookSegment>/<publicKey>/webhook`. */
  inboundWebhook: boolean;
  /** URL segment of the inbound webhook (lower-case, `a-z0-9-`); defaults to the kind in kebab case. */
  webhookSegment?: string | undefined;
  /** Customers reach it through the embeddable widget (`/ocso-webchat.js`, `data-key=<publicKey>`). */
  embeddable: boolean;
}
```

Other types you will use from the same file:

- `ChannelRuntimeConfig`: one channel instance, with `settings` and **already resolved** `secrets`, plus
  its public `webhookUrl` when the kind has one.
- `ChannelCapabilities`: part types in and out, text length limit, markdown flavour, media size and MIME
  allowlists, `sessionWindowHours` (WhatsApp: 24, others `null`) and the `identityKinds` the channel can
  address.
- `InboundEnvelope`: `messages`, delivery `statuses`, optional `identityUpdates`, and an `ignored` count.
- `SendResult`: `{ ok: true, externalMessageId }`, or a failure with `errorCode`, `retriable` and
  optionally `requiresTemplate`.

The adapter contract says it plainly: adapters "own transport concerns only … They never run the agent
loop and never touch the database."

Message templates (`listTemplates`, `sendTemplate`, `createTemplate`, `templateStatus`,
`deleteTemplate`, all optional) are being added to the contract for WhatsApp as this is written. Treat
them as in progress.

## How one is registered

`packages/bootstrap/src/channels.ts` builds the registry that both the api and the worker use:

```ts
export function createChannelRegistry(deps: { fetch?: typeof fetch; now?: () => Date } = {}): ChannelRegistry {
  const adapterDeps = { fetch: deps.fetch ?? fetch, now: deps.now ?? (() => new Date()) };
  return new ChannelRegistry()
    .register(createTwilioWhatsAppAdapter(adapterDeps))
    .register(createWhatsAppAdapter(adapterDeps))
    .register(createWebChatAdapter(adapterDeps));
}
```

The order is the order of the "Add channel" list. `ChannelRegistry.register` refuses a duplicate kind
and a duplicate or malformed webhook segment. The kind must also be listed in `CHANNEL_KINDS` in the
contract file, because `ChannelKind` is a closed union.

## What the core does for you

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

**Delivery statuses and identity changes.** Statuses are applied so they never move backwards.
`identityUpdates` re-link an existing customer identity instead of creating a new customer.

**Media.** A worker runs `fetchMedia` for each pending part, re-checks the bytes, and stores them in
the BlobStore. Throw `ChannelMediaError`: a `rejected` reason (too large, wrong type, bad host,
checksum) marks the part `REJECTED`; a retriable error retries the job.

**Outbound.** `DeliveryService` (`packages/agent-runtime/src/delivery/delivery.ts`) filters the
message to customer-safe parts your capabilities accept (tool results and internal notes never reach
`render`), picks the customer's identity in your `identityKinds` order, calls `render`, then `send`
per payload. A `retriable` failure is retried by the queue with exponential backoff, up to 8 attempts.
`requiresTemplate` marks the reply failed as `outside_session_window`.

**Administration.** `GET /v1/channels/kinds` returns each descriptor. The "Add channel" form in
`apps/web/components/connections/channels/` renders the settings from `settingsSchema` (titles,
descriptions and defaults from the zod `.meta()` and `.default()`), and one write-only field per entry
in `secrets`. A secret marked `generate: 'server'` is generated by OCSO when left empty;
`generate: 'client'` gets a Generate button in the form. When a channel is set Active, the service runs
`validateConfig`. Problems written as `settings.<path>: message` or `secrets.<key>: message` show
under the matching field. Secrets go to the SecretStore as `CHANNEL_TOKEN` references and are never
returned. If you implement `checkConnection`, the channel gets a **Test connection** button. The form
shows the webhook URL, built from your `webhookSegment`, for the admin to paste into the provider.

**Session windows.** Declare `sessionWindowHours`. The helper `withinSessionWindow` in
`contract/render-policy.ts` tells you whether a free-form send is allowed; the WhatsApp adapters check
it in `send` and return `requiresTemplate`.

## Skeleton

The shape of every shipped adapter: a class, a factory with injectable deps, and small modules for
config, descriptor, capabilities, verification, inbound parsing, rendering and sending.

```ts
// packages/channels/src/acme/adapter.ts
export class AcmeChannelAdapter implements ChannelAdapter {
  readonly kind = 'ACME' as const; // add 'ACME' to CHANNEL_KINDS first

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

export function createAcmeAdapter(deps: Partial<ChannelAdapterDeps> = {}): AcmeChannelAdapter {
  return new AcmeChannelAdapter({ fetch: deps.fetch ?? globalThis.fetch.bind(globalThis), now: deps.now ?? (() => new Date()) });
}
```

[add-a-channel.md](add-a-channel.md) fills this in for a Telegram-shaped channel.

## Tests to copy

All channel tests run offline with a fake `fetch` and provider-shaped fixtures.

- `packages/channels/test/adapters-contract.test.ts`: the shared contract. Add your adapter to the
  `adapters` array. It checks registration, that tool results never render, consistent media limits,
  and that your own valid config passes `validateConfig`.
- `packages/channels/test/twilio-*.test.ts` and `whatsapp-*.test.ts`: one file per concern (config,
  signature, inbound, media, render, send). `test/helpers/` builds configs and signed requests;
  `test/fixtures/` holds recorded-shape payloads.
- `apps/api/test/int/twilio-whatsapp.int.test.ts`: the real API against a local provider stub
  (`twilio-stub.ts`). It covers the generic webhook route, signature checks over the public URL,
  persist-once ingress, the acknowledgement, and the connection check.
- `apps/api/test/int/channels-admin.int.test.ts`: channel administration, kinds and secrets.

## Limits today

- Kinds are compiled in, and `ChannelKind` is a closed union.
- `CHANNEL_KINDS` also lists `SMS`, `RCS`, `VOICE` and `CUSTOM_APP`. No adapters exist for them.
- `embeddable` is effectively web chat only. The widget's customer API
  (`apps/api/src/modules/webchat/`, `/public/webchat/:publicKey/*`), the widget itself
  (`apps/web/components/webchat/`, `apps/web/public/ocso-webchat.js`) and the CSAT endpoint are core
  code written for `WEBCHAT`.
- Parts of the web app still carry per-kind maps: channel marks and labels
  (`apps/web/components/workspace/lib/channel.ts`,
  `apps/web/components/connections/channels/channels-tab.tsx`) and the provider-console steps shown
  after saving (`provider-steps.tsx`). A new kind still works without them, using the descriptor's label
  and a generic setup note.
- Adapters receive the plain global `fetch`. Enforce your own host allowlist for media downloads, as the
  WhatsApp adapters do (`common/safe-download.ts`).
- Outbound sends are at-least-once. If the provider has no idempotency key, a crash between the provider
  accepting a message and OCSO recording its id can send a duplicate (ADR-007).
