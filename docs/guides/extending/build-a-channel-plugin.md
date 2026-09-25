# Build a channel plugin

This guide shows how to add a messaging channel to OCSO: a new kind that appears under **Integrations → Channels →
Add channel**, with its own form, setup guide, webhook and inbox badge, and no change to OCSO's core. It is for
developers. It walks through the example plugin in
[examples/ocso-plugin-example-channel](../../../examples/ocso-plugin-example-channel/README.md), built only on the
public SDK `@winsendotai/ocso-plugin-sdk`, then covers the optional features and the first-party path.

Read [Plugins](../../concepts/plugins.md) for why the boundary exists, and the
[plugin SDK reference](../../reference/plugin-sdk.md) for every type.

## Two ways to ship a channel

| | Installed plugin | First-party adapter |
|---|---|---|
| Where the code lives | Your own npm package | `packages/channels/src/<kind>/` in this repository |
| Builds on | `@winsendotai/ocso-plugin-sdk` only | `@ocso/channels` contract and helpers (`@ocso/domain`, zod) |
| Registered by | `OCSO_PLUGINS` at start-up (`packages/bootstrap/src/plugins/loader.ts`) | One entry in `FIRST_PARTY_PLUGINS` (`packages/bootstrap/src/first-party.ts`) |
| Checked by | `checkPlugin` and the same registry checks | The same registry checks, plus the repo's contract tests |
| Can contribute | channels, model providers, alert destinations, email drivers (plugin API version 1) | anything, including tool providers and infrastructure drivers |

Both paths meet the same `ChannelRegistry` checks, so a channel that works as a plugin works first-party and the
other way round. Start with an installed plugin unless you are contributing the channel to OCSO itself.

## What OCSO does and what your adapter does

Your adapter owns transport only: verify the provider's requests, parse them into canonical messages, render OCSO's
message parts into the provider's format, and send. It never runs the agent loop and never touches the database.

OCSO does the rest:

- routes `/channels/<segment>/<publicKey>/webhook` to your adapter and loads the channel's settings and resolved
  secrets;
- stores each inbound message exactly once (keyed on your `externalMessageId`), resolves the customer from your
  identity, and answers the provider only after storing;
- routes the conversation (channel → router → queue → agent) and runs the AI turn;
- filters outbound messages to customer-safe parts your capabilities accept, retries failed sends with backoff
  (8 attempts), and applies delivery statuses so they never move backwards;
- renders the admin form, setup guide, channel card and inbox badge from your descriptor;
- runs drafts, activation and every later change through maker–checker approval.

## The example: a signed JSON-webhook channel

The example adds the kind `JSON_WEBHOOK` (badge `JS`). Any system that can send and receive signed JSON over HTTPS
can talk to OCSO through it:

- **Inbound:** `POST /channels/json-webhook/<publicKey>/webhook` with
  `x-ocso-signature: sha256=<hex HMAC-SHA256(raw body, signingSecret)>` and a body of `messages` and `statuses`.
- **Outbound:** OCSO posts `{ "id", "to", "text" }` to the configured `outboundUrl`, signed the same way.

```text
examples/ocso-plugin-example-channel/
  package.json         name, ESM exports, dependency on @winsendotai/ocso-plugin-sdk
  src/index.ts         definePlugin(...) as the default export
  src/adapter.ts       descriptor, capabilities and the ChannelAdapter
  src/signature.ts     HMAC signing and constant-time comparison
  test/plugin.test.ts  checkPlugin plus unit tests
```

### 1. The package and the plugin

The package is ESM, Node 20 or later, and depends on the SDK as a regular dependency, because the plugin imports
`definePlugin` and `pluginError` at runtime. Its default export is the plugin:

```ts
// src/index.ts
import { definePlugin } from '@winsendotai/ocso-plugin-sdk';
import { createJsonWebhookAdapter } from './adapter.js';

export default definePlugin({
  apiVersion: 1,
  name: '@ocso-examples/ocso-plugin-example-channel', // by convention, the npm package name
  channels: [createJsonWebhookAdapter],
});
```

The `@ocso/` scope is reserved for OCSO's own plugins; `checkPlugin` refuses it.

### 2. The descriptor

The descriptor is everything OCSO shows about the kind. Nothing in the web app knows about your kind: it renders the
descriptor, served by `GET /v1/channels/kinds`.

```ts
const DESCRIPTOR: ChannelKindDescriptor = {
  kind: 'JSON_WEBHOOK',                 // upper snake case, 2–40 characters
  label: 'JSON webhook (example)',      // the "Add channel" list and the card
  description: 'Exchange messages with any system that can send and receive signed JSON over HTTPS.',
  mark: { code: 'JS', name: 'JSON webhook' }, // the inbox badge: 1–3 letters or digits
  settingsSchema: {                     // JSON Schema of the non-secret settings: the form
    type: 'object',
    properties: { outboundUrl: { type: 'string', title: 'Outbound URL', description: 'HTTPS endpoint OCSO posts replies to.' } },
    required: ['outboundUrl'],
  },
  secrets: [{ key: 'signingSecret', label: 'Signing secret', required: true, hint: 'Shared HMAC-SHA256 key, at least 16 characters.', generate: 'client' }],
  identitySetting: { label: 'Outbound URL', keys: ['outboundUrl'] }, // shown on the channel card
  setupSteps: [ /* three plain sentences */ ],
  inboundWebhook: true,                 // POST /channels/<segment>/<publicKey>/webhook
  webhookEvents: 'messages, delivery statuses',
  embeddable: false,
};
```

- **Settings** are JSON Schema. `title` and `description` become the field label and hint; `default` becomes the
  "blank = default" hint. First-party adapters write a zod schema and convert it with `z.toJSONSchema(…, { io: 'input' })`.
- **Secrets** are write-only fields. `generate: 'client'` adds a **Generate** button (for values the admin must copy
  into the provider); `generate: 'server'` lets OCSO generate the value when left empty; `reveal: 'once'` returns a
  server-generated value once to the creator.
- **Webhook segment** defaults to the kind in kebab case (`json-webhook`); set `webhookSegment` to choose another
  (lower case `a-z0-9-`).

> [!TIP]
> The example uses `setupSteps`, which is deprecated: plain sentences, one guide step each. Write a `setupGuide`
> instead, as Slack and Teams do: one step per screen of the provider's console, `values` to copy (placeholders
> `{{webhookUrl}}`, `{{webhookHost}}`, `{{settings.<key>}}`), `links` (https only), `check` (how to tell the step
> worked), and `form: true` on the one step where OCSO's own form belongs. Add `troubleshooting` entries with stable
> `id`s. Webhook kinds are created as a draft first so the guide can show the real webhook URL before the admin has
> credentials. See [Slack's descriptor](../../../packages/channels/src/slack/descriptor.ts) for a complete guide.

### 3. Capabilities

Capabilities tell OCSO what the channel can carry. The outbound filter, the prompt's channel block and the session
window all read them.

```ts
const CAPABILITIES: ChannelCapabilities = {
  inboundParts: ['TEXT'],
  outboundParts: ['TEXT', 'STRUCTURED'], // STRUCTURED so choice questions reach render (as their text fallback)
  maxTextLength: 4_000,
  markdown: 'none',                      // 'none' | 'basic' | 'commonmark'
  streaming: false,
  deliveryReceipts: true,
  interactive: false,
  maxMediaBytes: { IMAGE: 0, AUDIO: 0, VIDEO: 0, DOCUMENT: 0 },
  allowedMimeTypes: { IMAGE: [], AUDIO: [], VIDEO: [], DOCUMENT: [] },
  sessionWindowHours: null,              // WhatsApp: 24
  identityKinds: ['json_webhook_user'],  // identities this channel can address, in order of preference
};
```

### 4. Validate the configuration

`validateConfig(settings, secrets)` returns human-readable problems and never echoes secret values. It runs on every
save. Write problems as `settings.<path>: message` or `secrets.<key>: message` and the form shows them under the
matching field. On a draft, problems about a value not given at all are set aside until activation.

### 5. Verify, then parse

`verifyRequest` runs before anything is parsed or stored. Compare secrets in constant time:

```ts
verifyRequest(req, config) {
  if (req.method !== 'POST' || !req.rawBody) return { kind: 'rejected', status: 400, reason: 'expected a signed JSON POST' };
  return signatureMatches(secretOf(config), req.rawBody, req.headers['x-ocso-signature'])
    ? { kind: 'verified' }
    : { kind: 'rejected', status: 401, reason: 'signature mismatch' };
}
```

- Reject with `401` for a missing or expired credential and `403` for a wrong one. OCSO answers the provider
  accordingly and stores nothing.
- `verifyRequest` may return a `Promise`, for checks that need the network (Teams verifies a bearer JWT against
  Microsoft's published keys). Cache what you fetch.
- A subscription handshake returns `{ kind: 'challenge', status: 200, body }`: on `GET` (Meta's verify token) or on a
  verified `POST` (Slack's `url_verification`). OCSO answers with the body and stores nothing.
- `req.url` is OCSO's public origin plus the path and query exactly as received, for URL-bound signatures such as
  Twilio's.

`parseInbound` turns one webhook body into an `InboundEnvelope`: `messages`, delivery `statuses`, and an `ignored`
count for events you do not handle. Each message carries `externalMessageId` (the idempotency key: a provider retry
becomes a duplicate, not a second message), `identityKind` and `identityValue`, `receivedAt`, and `parts`.

```ts
return {
  externalMessageId: id,
  identityKind: 'json_webhook_user',
  identityValue: from,
  alternateIdentities: [],
  ...(name ? { profileName: name } : {}),
  receivedAt,
  parts: [{ type: 'TEXT', text: body }],
};
```

Throw `pluginError('validation', code, message)` for a malformed body. OCSO translates it into a `400`.

### 6. Media

`fetchMedia` downloads media that `parseInbound` marked `PENDING`; OCSO re-checks the bytes against your capabilities
and stores them. The example carries text only, so it rejects every call with a `pluginError`.

### 7. Render and send

`render` receives only customer-safe parts your `outboundParts` allow and returns one or more payloads. Keep each
payload's source `partIndexes`. Chunk to your text limit.

`send` makes one provider call per payload through **the injected `fetch`**, never the global one. That `fetch` is
OCSO's SSRF-guarded egress: public https hosts, plus internal hosts only if a Tech admin allowlisted them.

```ts
const response = await deps.fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ocso-signature': sign(secretOf(config), body) },
  body,
  signal: AbortSignal.timeout(10_000),
});
if (response.ok) return { ok: true, externalMessageId: id };
const retriable = response.status === 429 || response.status >= 500;
return { ok: false, errorCode: `http_${response.status}`, message: `The outbound URL answered ${response.status}`, retriable };
```

Return `retriable: true` for rate limits, 5xx and network errors; OCSO retries with backoff. Never put a secret in
`message`. Set `requiresTemplate: true` when the provider refuses a free-form message outside its session window.

### 8. Test

```ts
import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
import plugin from '../src/index.js';

it('passes the SDK conformance checks', () => {
  expect(checkPlugin(plugin)).toEqual([]);
});
```

`checkPlugin` returns every problem OCSO would refuse the plugin for at start-up: API version, name, kind and mark
patterns, duplicate kinds, `embeddable` without `embed` hooks (or the reverse), template methods without template
terms (or the reverse), webhook segments, setup guide rules, `staffDestination` and `staffSurface`, and missing
methods. It builds each adapter with stand-in dependencies that have no network, so factories must not do I/O while
being built. It cannot see a kind clash with another installed plugin; OCSO reports those at start-up.

Test the rest with the injected `fetch` and clock: `createJsonWebhookAdapter({ fetch, now })`. The example's tests
cover signature checks, inbound parsing, chunked rendering, signed sends and typed errors:

```sh
pnpm --filter @ocso-examples/ocso-plugin-example-channel build
pnpm vitest run --project unit examples/ocso-plugin-example-channel
```

`packages/bootstrap/test/sdk-example-plugin.test.ts` installs the built example and the SDK side by side, the way
`npm install --prefix <OCSO_PLUGINS_DIR>` does, and loads it through the real loader.

### 9. Install it into OCSO

1. Publish the package, or pack it. The SDK is not on npm yet, so pack it too:
   `pnpm --filter @winsendotai/ocso-plugin-sdk pack`.
2. Install both into the plugins directory of the api and worker images, at exact versions:
   `npm install --prefix /app/plugins <sdk tarball> <plugin tarball>`.
3. List the plugin in `OCSO_PLUGINS` for the api, the worker and the seed:

   ```sh
   OCSO_PLUGINS=@ocso-examples/ocso-plugin-example-channel@0.1.0
   OCSO_PLUGINS_DIR=/app/plugins   # the default
   ```

4. Restart. Each process logs a `plugins:` line listing it. **System → Plugins** shows it, and **Add channel** lists
   "JSON webhook (example)".

A plugin runs in-process with OCSO's full trust. A missing package, a version that differs from the pin, another
plugin API version or a refused contribution stops the process at start-up with every problem listed. The full
procedure (derived images, Compose overrides, upgrades) is in [Install a plugin](install-a-plugin.md).

> [!NOTE]
> The tarball steps above follow from how the loader and its test work. They have not been run against a published
> OCSO image in this repository.

## Optional features

Each one is opt-in and checked at registration.

| Feature | What to add | What OCSO gives you |
|---|---|---|
| **Test connection** | `checkConnection(config)`: read-only provider calls returning `{ ok, checks: [{ name, ok, detail, help? }] }`. `help` is a troubleshooting `id`. | A **Test connection** button (`POST /v1/channels/:id/test`); failed checks link to the fix. |
| **Choice questions** | `capabilities.choices: { buttons, list }`. In `render`, turn a `STRUCTURED` part with `schema: 'ocso.choices'` and `data: { text, options: [{ id, label }] }` into native buttons, keeping each option's `id`. Normalize a tap to a `STRUCTURED` part with `schema: 'button_reply'`, `data.id` = the option id and `fallbackText` = its label. | Routers ask natively on your channel. Without it, the part's numbered `fallbackText` is sent. |
| **Reply context** | `replyContext` on inbound messages: up to 16 string values, 4,096 bytes of JSON (a thread, a conversation reference). | It comes back as `OutboundTarget.replyContext` for the reply to that message. Have a fallback in `send` for when it is absent. |
| **Identity display** | `displayIdentity(identityKind, value)`, returning `null` for kinds that are not yours. | Your format in staff lists instead of the generic masking. |
| **Setup files** | `setupFiles`: text templates (JSON, YAML, text) or an `application/zip` with text entries and base64 PNGs. Secrets are never interpolated. | Copy and download in the guide; `GET /v1/channels/:id/setup-files/:key` builds zips on the server. |
| **Message templates** | `listTemplates`, `createTemplate`, `sendTemplate` (plus optional `templateStatus`, `deleteTemplate`) and `templates` terms in the descriptor, all together. | The **Message templates** page, the composer's **Template** mode, template approvals and the review poller. |
| **Embeddable widget** | `embeddable: true` and `embed` hooks (`widgetConfig`, `openSession`, `identify`, `attachmentKeyPrefix`; optional `mintSessionPass`). | OCSO's widget script, the `/chat/<publicKey>` page and the public web chat API. |
| **Staff chat (Ask OCSO)** | `staffDestination: true`, optionally `staffSurface`. Do not declare a `destination` setting yourself. | OCSO adds the **Destination** setting (`router` or `ask_ocso`) and runs account linking. |
| **Custom acknowledgement** | `webhookAcknowledgement()` | Your body and content type instead of the JSON summary (Twilio answers empty TwiML). |

## The first-party path

To contribute a channel to OCSO itself:

1. Add `packages/channels/src/<kind>/` with the shipped adapters' shape: `config.ts` (zod settings and
   `validateConfig`), `descriptor.ts`, `capabilities.ts`, `adapter.ts` (a class plus a factory
   `create…Adapter(deps)` that falls back to `NO_NETWORK`, never the global `fetch`), and one module per concern.
   Reuse `packages/channels/src/common/` (chunking, constant-time compare, redaction, safe downloads).
2. Export it from `packages/channels/src/index.ts`.
3. Add the factory to the `@ocso/channels` entry of `FIRST_PARTY_PLUGINS` in
   [packages/bootstrap/src/first-party.ts](../../../packages/bootstrap/src/first-party.ts). The order there is the
   order of the **Add channel** list. The api, the worker and the seed all build their registries from this list.
4. Add the adapter to `packages/channels/test/adapters-contract.test.ts`, write one test file per concern with
   recorded-shape fixtures (see the `slack-*.test.ts` and `twilio-*.test.ts` files), and an API integration test
   against a local stub like `apps/api/test/int/slack-channel.int.test.ts`. A stub on loopback must be allowlisted
   first (`egressAllowedInternalHosts` in deployment settings), or the egress guard refuses it.
5. Run `pnpm lint`, `pnpm typecheck` and `pnpm test`. `scripts/plugin-boundary.mjs` fails the build if core code names
   your kind: the kind may appear only inside your package.

Nothing else changes: no migration (the `channels.kind` column is text), no API route, no web UI.

## Limits and known gaps

- Plugin API version 1 covers channels, model providers, alert destinations and email drivers. Tool providers and
  infrastructure drivers are first-party only.
- Plugins run in-process with full trust; there is no sandbox.
- The SDK is not on npm yet.
- The template draft rules follow WhatsApp, today's only template network. A kind with different rules can refuse a
  draft from `createTemplate` with a typed error.
- The widget's public API keeps its historical path, `/public/webchat/<publicKey>/*`, for every embeddable kind.

## Related

- [Plugins](../../concepts/plugins.md)
- [Plugin SDK reference](../../reference/plugin-sdk.md)
- [Install a plugin](install-a-plugin.md)
- [Channels overview](../channels/README.md)
- [examples/ocso-plugin-example-channel](../../../examples/ocso-plugin-example-channel/README.md)
- [packages/ocso-plugin-sdk/README.md](../../../packages/ocso-plugin-sdk/README.md)
