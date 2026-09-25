# Plugin SDK reference

`@winsendotai/ocso-plugin-sdk` is the public contract for OCSO plugins: types, a few small helpers and a
conformance checker. This page is for developers who build a channel, model provider, alert destination or email
driver outside the OCSO repository. For a walkthrough, read
[build a channel plugin](../guides/extending/build-a-channel-plugin.md); for installing one, read
[install a plugin](../guides/extending/install-a-plugin.md).

Source: [`packages/ocso-plugin-sdk`](../../packages/ocso-plugin-sdk) (its
[README](../../packages/ocso-plugin-sdk/README.md) is the package's own documentation). A complete example with
tests: [`examples/ocso-plugin-example-channel`](../../examples/ocso-plugin-example-channel).

> [!NOTE]
> The package is at version 0.1.0 and **not published to npm yet**. Build it from the repository with
> `pnpm --filter @winsendotai/ocso-plugin-sdk build` and install the tarball from
> `pnpm --filter @winsendotai/ocso-plugin-sdk pack`.

## Package facts

| | |
|---|---|
| Name | `@winsendotai/ocso-plugin-sdk` |
| Version | `0.1.0` (plugin API version `1`) |
| Entry points | `.` (types and helpers), `./testing` (`checkPlugin` and stand-in dependencies) |
| Module format | ESM only. `require()` works without a flag on Node 22.12+ and 20.19+. |
| Node | 20 or later |
| Runtime dependencies | none |
| Peer dependencies (optional) | `zod ^4` (model provider plugins need it at runtime), `@types/node` (the types mention `Buffer`) |
| License | Apache-2.0 |

## `apiVersion` and `definePlugin`

A plugin is an npm package whose default export (or a `plugin` named export) describes what it adds to OCSO's
registries.

```ts
import { definePlugin } from '@winsendotai/ocso-plugin-sdk';

export default definePlugin({
  apiVersion: 1,
  name: '@acme/ocso-channel-line', // by convention the npm package name
  channels: [createLineAdapter],
});
```

- `OCSO_PLUGIN_API_VERSION` is `1`. OCSO refuses a plugin whose `apiVersion` it does not implement, with a message
  naming both versions.
- `definePlugin(plugin)` is an identity function: it only types the object (`OcsoPluginV1`).
- `name` must be non-empty, have no leading or trailing spaces, be at most 214 characters, be unique among loaded
  plugins, and must not start with `@ocso/` (reserved for first-party plugins).

`OcsoPluginV1`:

| Key | Type | Selected by |
|---|---|---|
| `apiVersion` | `1` | |
| `name` | `string` | |
| `channels` | `ChannelAdapterFactory[]`: `(deps: ChannelAdapterDeps) => ChannelAdapter` | an admin adds a channel of that kind |
| `modelProviders` | `ProviderDefinition[]` | an admin adds a model provider of that kind |
| `alertDestinations` | `AlertDestinationFactory[]`: `(deps: DeliveryAdapterDeps) => AlertDeliveryAdapter` | an admin adds a notification destination |
| `emailDrivers` | `EmailDriverDefinition[]` | the operator sets `EMAIL_DRIVER=<name>` |

**Not contributable in API version 1:** `toolProviders`, `blobDrivers`, `secretsDrivers`, `queueDrivers`,
`deploymentDrivers`, `auditStoreDrivers`. Their contracts depend on OCSO's internal database and configuration
packages. `checkPlugin` and OCSO's loader refuse a plugin that sets any of them; other extra keys are ignored.
External tools reach OCSO through MCP servers instead (see [MCP tools](../guides/tools/mcp.md)).

### Name patterns

Exported from the package root:

| Constant | Pattern | Used for |
|---|---|---|
| `CHANNEL_KIND_PATTERN`, `PROVIDER_KIND_PATTERN`, `DESTINATION_KIND_PATTERN` | `^[A-Z][A-Z0-9_]{1,39}$` | kinds (`LINE`, `ACME_SMS`) |
| `DRIVER_NAME_PATTERN` | `^[a-z][a-z0-9-]{0,39}$` | email driver names (`postmark`) |
| `MARK_CODE_PATTERN` | `^[A-Za-z0-9]{1,3}$` | a channel's badge text |
| `WEBHOOK_SEGMENT_PATTERN` | `^[a-z0-9][a-z0-9-]{0,39}$` | inbound webhook URL segment; default from `defaultWebhookSegment(kind)` (`TWILIO_WHATSAPP` becomes `twilio-whatsapp`) |
| `SETUP_FILE_PLACEHOLDER_PATTERN` | `{{webhookUrl}}`, `{{webhookHost}}`, `{{settings.<key>}}` | setup-file templates (secrets are never interpolated) |

Also exported: `TROUBLESHOOTING_ID_PATTERN`, `SETUP_FILE_KEY_PATTERN`, `SETUP_FILE_NAME_PATTERN`,
`EMBED_PAGE_PREFIX` (`/chat`), `REPLY_CONTEXT_MAX_KEYS` (16) and `REPLY_CONTEXT_MAX_BYTES` (4096).

## The four public contracts

### Channels: `ChannelAdapter`

Source: [`channels.ts`](../../packages/ocso-plugin-sdk/src/channels.ts),
[`descriptor.ts`](../../packages/ocso-plugin-sdk/src/descriptor.ts),
[`embed.ts`](../../packages/ocso-plugin-sdk/src/embed.ts). Adapters own transport only: verification, identity
extraction, normalization, media, rendering, sending and delivery status. They never run the agent loop, never
touch the database, and reach the network only through `deps.fetch`.

`ChannelAdapterDeps` is `{ fetch, now }`. `fetch` is OCSO's SSRF-guarded egress (public HTTPS hosts plus the
operator's internal allowlist).

| Member | Required | Purpose |
|---|---|---|
| `kind` | yes | Upper snake case. |
| `describe(): ChannelKindDescriptor` | yes | Everything the web app shows: `label`, `description`, `mark { code, name, tone? }`, `settingsSchema` (JSON Schema), `secrets[]` (`key`, `label`, `required`, `hint`, `generate?`, `prefix?`, `reveal?`), `setupGuide[]` steps, `troubleshooting[]`, `setupFiles[]`, `inboundWebhook`, `webhookSegment?`, `embeddable`, `templates?`, `staffDestination?`, `staffSurface?`. OCSO renders it with generic forms; a plugin never ships web UI. |
| `capabilities(config): ChannelCapabilities` | yes | Inbound and outbound part types, `maxTextLength`, `markdown` (`none`, `basic`, `commonmark`), `streaming`, `deliveryReceipts`, `interactive`, media limits and MIME types, `sessionWindowHours`, `identityKinds?`, `choices?`. |
| `validateConfig(settings, secrets): string[]` | yes | Problems with admin-entered settings. |
| `verifyRequest(req, config)` | yes | Runs before anything is parsed or stored. Returns (or resolves to) `{ kind: 'verified' }`, `{ kind: 'challenge', status: 200, body }` or `{ kind: 'rejected', status: 400 \| 401 \| 403, reason }`. |
| `parseInbound(req, config): InboundEnvelope` | yes | `{ messages, statuses, identityUpdates?, templateUpdates?, ignored }`. Each `InboundMessage` has `externalMessageId` (the idempotency key), `identityKind`, `identityValue`, `receivedAt`, `parts`, and optionally `replyContext` (opaque, handed back on replies). |
| `fetchMedia(ref, config)` | yes | Download inbound media. |
| `render(parts, config): RenderedOutbound[]` | yes | Turn customer-safe parts into channel payloads (chunking, formatting). |
| `send(target, message, config, media): SendResult` | yes | `{ ok: true, externalMessageId }` or `{ ok: false, errorCode, message, retriable, requiresTemplate? }`. |
| `embed: EmbeddedChat` | when `embeddable` | The public widget protocol: `widgetConfig`, `openSession`, `identify`, `attachmentKeyPrefix`, optional `mintSessionPass` and `openUserToken`. |
| `displayIdentity`, `webhookAcknowledgement`, `checkConnection` | no | Staff-facing identity text, a custom webhook reply body, a read-only credential check. |
| `listTemplates`, `createTemplate`, `sendTemplate` | no, but all three or none | Message templates (also `templateStatus`, `deleteTemplate`); describe `templates` when implemented. |

A workplace chat kind (Slack, Teams) sets `staffDestination: true`; OCSO then adds a `destination` setting
(`router` or `ask_ocso`) so the channel can serve Ask OCSO. See
[Ask OCSO in Slack and Teams](../guides/channels/ask-ocso-in-slack-and-teams.md).

### Model providers: `ProviderDefinition`

Source: [`model-providers.ts`](../../packages/ocso-plugin-sdk/src/model-providers.ts).

| Member | Purpose |
|---|---|
| `kind`, `label`, `mark` (1–4 characters), `cachingSummary` | Identity and admin UI text. |
| `devOnly` | Registered only when the operator sets `OCSO_ENABLE_DEV_PROVIDERS`. |
| `settingsSchema`, `credentialsSchema` | zod 4 schemas (`ZodType`) that OCSO turns into form fields. Credentials are stored in the secret store. |
| `catalog?: ProviderCatalogMapping` | Maps model ids to models.dev and LiteLLM catalog keys for pricing. |
| `capabilities(model, settings): ModelCapabilities` | Image, file, audio input, tool calling, structured output, reasoning, streaming, `promptCaching` (`EXPLICIT`, `AUTOMATIC`, `UNSUPPORTED`, `UNVERIFIED`). |
| `providerOptions(model, request, settings): ProviderOptionsPlan` | Per-request provider options (Vercel AI SDK `providerOptions` shape), including cache breakpoint markers. |
| `describeCaching?`, `baseModel?` | Admin UI caching description; the base model for pricing. |
| `create(config, deps): ModelProviderAdapter` | An adapter bound to one configured provider: `capabilities(model)`, `stream(request, model)` (ends with a `finish` event), `generate(request, model)`, `health(model?)`, optional `listModels()`. |

`ModelResult` carries text, tool calls, `finishReason`, `NormalizedUsage` (where `null` means "not reported", never
zero), identity, latency and warnings. Model provider adapters are not given the guarded `fetch` today;
`AdapterDeps.fetch` exists for contract tests.

### Alert destinations: `AlertDeliveryAdapter`

Source: [`alerts.ts`](../../packages/ocso-plugin-sdk/src/alerts.ts). `DeliveryAdapterDeps` is `{ fetch,
mailTransport, emailSender?, timeoutMs?, now? }`.

| Member | Purpose |
|---|---|
| `kind`, `label`, `description` | Identity and the "Add destination" form text. |
| `events` | Non-empty subset of `ALERT_EVENTS`: `OPENED`, `ACKNOWLEDGED`, `RESOLVED`, `REMINDER`. |
| `configSchema` | JSON Schema (draft 2020-12) of the non-secret config. |
| `secret: SecretRequirement \| null` | The destination's single secret (`required`, `secretKind`, `label`, `description`, `when?`). |
| `validateConfig(config)`, `validateSecret(secret)`, `summary(config)` | Validation and a one-line description. |
| `deliver(message, config, secret): Promise<DeliveryResult>` | Never throws for delivery failures: returns `{ ok, retriable, error?, externalId? }`. Helpers `delivered(externalId?)` and `failed(retriable, error)`. |

`AlertMessage` is channel-neutral and contains no secrets (`alertId`, `deliveryId` as an idempotency key, `event`,
`severity`, `status`, `title`, `body`, `link`, timestamps and more).

### Email drivers: `EmailDriverDefinition`

Source: [`email.ts`](../../packages/ocso-plugin-sdk/src/email.ts).

| Member | Purpose |
|---|---|
| `name` | The `EMAIL_DRIVER` value (`DRIVER_NAME_PATTERN`). |
| `label` | Display name in **Settings → Email**. |
| `delivers` | `false` for a driver that never hands a message to anyone (development). |
| `resolve(env: EmailEnv, ctx: EmailDriverContext)` | Validate settings and resolve secrets once at start-up. Returns options, or `null` after `ctx.problem(...)`. `ctx.secret(value, file, name)` reads a value inline or from a file. |
| `create(options, sender, deps): EmailSender` | The sender: `send(message)` returns `{ id }`. |

`EmailEnv` lists only the variables OCSO itself parses (`EMAIL_*`, `RESEND_*`, `SMTP_*`, `NODE_ENV`). A plugin
driver reads its own settings from `process.env` in `resolve`.

## Errors: `pluginError`

Source: [`errors.ts`](../../packages/ocso-plugin-sdk/src/errors.ts).

```ts
import { pluginError } from '@winsendotai/ocso-plugin-sdk';

throw pluginError('authentication', 'line_token_expired', 'The channel access token has expired', { status: 401 });
```

`pluginError(category, code, message, details?)` returns a plain `Error` with a non-enumerable, frozen `ocsoError`
marker `{ category, code, details? }`. OCSO's loader translates marked errors into its own typed errors at the
plugin boundary; an unmarked error becomes an internal error (500). `isPluginError()` recognizes the marker by
shape, so it works across copies of the package. `details` must never contain secrets.

| `ErrorCategory` | HTTP status in OCSO | Retried |
|---|---|---|
| `validation` | 400 | no |
| `authentication` | 401 | no |
| `authorization`, `policy_denied` | 403 | no |
| `not_found` | 404 | no |
| `conflict` | 409 | no |
| `tool_rejected` | 422 | no |
| `provider_rate_limited` | 429 | yes |
| `provider_unavailable`, `tool_unavailable` | 502 | yes |
| `capacity` | 503 | yes |
| `timeout` | 504 | yes |
| `internal` | 500 | no |

`RETRIABLE_CATEGORIES` holds the retried ones. For email drivers, an integer `details.status` is kept as the
provider's status code, and any unmarked error is treated as transient.

## Testing: `checkPlugin`

```ts
import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
import plugin from '../src/index.js';

test('OCSO accepts the plugin', () => {
  expect(checkPlugin(plugin)).toEqual([]);
});
```

`checkPlugin(plugin): string[]` returns every problem OCSO would refuse the plugin for at start-up, as readable
lines: the envelope (`apiVersion`, `name`, internal-only keys), kind and driver-name patterns and duplicates, the
channel mark code, `embeddable` exactly when `embed` hooks exist, templates (all three methods or none), webhook
segments, `staffDestination` and `staffSurface`, alert destination events, and missing methods. It runs the same
checks as OCSO's registries; the OCSO repository runs both over every first-party contribution and requires the
same verdict.

It builds each channel and alert destination with stand-in dependencies that have no network access
(`CHECK_CHANNEL_DEPS`, `CHECK_ALERT_DEPS`, also exported), so factories must not do I/O while being built. It cannot
see a clash with another installed plugin's kind; OCSO reports those at start-up. `PUBLIC_CONTRIBUTIONS` lists the
four accepted keys.

## Versioning promise

- `apiVersion` (and `OCSO_PLUGIN_API_VERSION`) is the contract handshake. It changes only for a breaking change to
  a plugin contract. An OCSO release states which plugin API versions it runs; today OCSO runs version `1` only
  (`packages/bootstrap/src/plugins/validate.ts`).
- The package follows semver. While it is 0.x, minor releases may add optional members to the contracts. Anything
  that would break a plugin compiled against an earlier 0.x of the same `apiVersion` raises `apiVersion`.
- The contract types are copies of OCSO's internal contracts. A type-level test in the OCSO repository fails when
  they drift, so an SDK release matches the OCSO release it names.

## Trust

A plugin runs **in-process** in the api and the worker with OCSO's full access: the environment (database URL,
secrets master key), the network and the filesystem. OCSO checks versions and contribution shapes; it does not
sandbox plugin code. Operators install only plugins they trust, pinned to exact versions.

## Related

- [Build a channel plugin](../guides/extending/build-a-channel-plugin.md)
- [Install a plugin](../guides/extending/install-a-plugin.md)
- [Plugins concept](../concepts/plugins.md)
- [Chat SDK](chat-sdk.md)
- [Configuration: plugins](configuration.md#plugins)
