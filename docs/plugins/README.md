# Plugins and extension points

OCSO is a core plus a set of contracts. The core owns what every deployment needs: the conversation
runtime, human handoff, roles and permissions, audit, queues and leases, and observability. Everything
that touches an outside system sits behind a contract and is looked up in a registry: customer
channels, model providers, tool servers, email, blob storage, secrets, alert destinations and
conditions, scheduled tasks, and the tools of the internal agent.

This page defines what "plugin" means in this repository, shows the one plugin shape and the
composition root that registers it, lists every extension point, and says where the boundary still
leaks.

## What "plugin" means here

A plugin is a package that contributes implementations of OCSO's TypeScript contracts. The core looks
each one up by kind (or driver name) in a registry: it asks for "the adapter for `TWILIO_WHATSAPP`" and
calls the contract, and it never switches on the kind. The build rules require this: avoid "huge
switch statements for every provider/channel/tool" ([§2](../99-BUILD-RULES.md#2-no-large-monolith-files))
and keep external implementations behind adapters ([§4](../99-BUILD-RULES.md#4-pluginsadapters-at-external-boundaries)).

- **One plugin shape, one composition root.** Every plugin is an `OcsoPlugin` object; the list the
  build runs is `FIRST_PARTY_PLUGINS` in `packages/bootstrap/src/first-party.ts`. The api, the worker
  and the demo seed build every registry from that list and nothing else (see
  [The plugin shape](#the-plugin-shape)). This is the seam a plugin loader will extend.
- **First-party plugins are compiled in; third-party ones are loaded.** Each first-party implementation lives in a
  workspace package and one entry in `FIRST_PARTY_PLUGINS` registers it. Third-party packages built on
  `@winsendotai/ocso-plugin-sdk` are listed in `OCSO_PLUGINS` and appended to that list at start-up (see below).
- **Kinds are open.** A kind exists when a registered plugin declares it: `ChannelKind`, `ProviderKind`
  and alert destination kinds are strings, and API input is validated against the registry, never
  against a hard-coded list. The `kind` columns are `text`, so a new kind needs no migration.
  Infrastructure drivers are registries too: `EMAIL_DRIVER`, `BLOB_DRIVER`, `SECRETS_DRIVER`,
  `QUEUE_DRIVER`, `DEPLOYMENT_DRIVER` and `AUDIT_DRIVER` name a registered driver, and an unknown name fails start-up
  with the list of registered ones.
- **Per-kind knowledge lives in the plugin.** Labels, marks, setup steps, form schemas, caching wording,
  catalog mapping, public paths and capabilities are part of the adapter, descriptor or definition.
  The web app reads them from the `/kinds` endpoints (for example `GET /v1/channels/kinds`,
  `GET /v1/model-providers/kinds`, `GET /v1/notification-destinations/kinds`) and renders a kind it has
  never seen with generic defaults.
- **Kinds are code, instances are configuration.** A kind (say, WhatsApp via Twilio) is compiled in.
  An instance of it (your WhatsApp number, with its credentials) is created by a Tech admin
  in the web app, stored in PostgreSQL, and its secrets go to the SecretStore.
- **Two extension points need no code at all.** Any MCP server can be connected at runtime from the
  web app ([tools-and-mcp.md](tools-and-mcp.md)), and OIDC or SAML identity providers are added the
  same way ([sign-in-and-sso.md](sign-in-and-sso.md)).

## The plugin shape

`packages/bootstrap/src/plugin.ts`:

```ts
export interface OcsoPlugin {
  readonly name: string; // unique; by convention the npm package name
  readonly channels?: readonly ChannelAdapterFactory[];        // (deps: { fetch, now }) => ChannelAdapter
  readonly modelProviders?: readonly ProviderDefinition[];
  readonly alertDestinations?: readonly AlertDestinationFactory[]; // (deps: { fetch, mailTransport, emailSender, … }) => AlertDeliveryAdapter
  readonly toolProviders?: readonly ToolProviderSourceFactory[];   // (deps: { db, secrets, settings }) => ToolProviderSource
  readonly emailDrivers?: readonly EmailDriverDefinition[];
  readonly blobDrivers?: readonly BlobDriverDefinition<DriverEnv>[];
  readonly secretsDrivers?: readonly SecretStoreDriverDefinition<DriverEnv>[];
  readonly queueDrivers?: readonly QueueDriverDefinition<DriverEnv>[];
  readonly deploymentDrivers?: readonly DeploymentDriverDefinition<WorkerEnv>[];
}
```

Definitions that need nothing from the host (model providers, drivers) are listed as they are.
Adapters that need host services are factories the host calls with them: channel adapters get the
SSRF-guarded egress fetch and the clock, alert adapters the guarded fetch and the deployment email
sender, tool sources the database. So a plugin never reaches the network on its own terms.

The composition root turns the list into registries — `createChannelRegistry`,
`createProviderRegistry` (dev-only providers only with `OCSO_ENABLE_DEV_PROVIDERS=true`),
`createAlertDeliveryRegistry`, `createRuntimeToolRegistry`, `createDriverRegistries` — and the api and
worker provide the list once, under the `PLUGINS` injection token, so every registry of a process is
built from the same plugins. Plugin names must be unique, and a registry refuses a duplicate kind.

## Extension points

| Extension point | Contract | Shipped implementations | What the core does for you |
|---|---|---|---|
| [Channels](channels.md) | `ChannelAdapter` (`packages/channels/src/contract/types.ts`), `ChannelKindDescriptor` (`contract/descriptor.ts`) | WhatsApp via Twilio, WhatsApp via Meta Cloud API, web chat | Webhook route per kind, persist-before-ack ingress with dedupe, identity resolution, media fetch jobs, customer-safe rendering filter, delivery retries, admin form from JSON Schema, encrypted secrets |
| [Model providers](model-providers.md) | `ProviderDefinition` (`packages/model-providers/src/providers/definition.ts`), `ModelProviderAdapter` (`contract/types.ts`) | AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic, Sarvam (plus a development-only scripted provider) | Shared AI SDK call path, usage and error normalization, secret scrubbing, health checks, admin form from zod schemas, profiles with fallbacks and policy checks, cost telemetry |
| [Tools (built-in and MCP)](tools-and-mcp.md) | `ToolProviderSource`, `ToolProvider` (`packages/tools/src/registry.ts`, `provider.ts`); any MCP server over Streamable HTTP | Built-in OCSO tools (`@ocso/agent-runtime`), `McpToolProvider` connections (`@ocso/mcp`, added in the web app) | One authorization and `tool_calls` audit path for every call, discovery, OAuth 2.1 or static-header auth, risk classification and approval, human confirmation, SSRF-guarded egress, health checks |
| [Alert destinations](alerts.md#delivery-destinations) | `AlertDeliveryAdapter` (`packages/alerts/src/contract.ts`) | In-app, email, Slack, Microsoft Teams, signed webhook, PagerDuty | Dispatch per lifecycle event, retries with backoff, encrypted secrets, test button, form from the adapter's schema |
| [Email drivers](email.md) | `EmailDriverDefinition`, `EmailSender` (`packages/email/src/contract.ts`) | Resend, SMTP, log (development) | Typed templates, start-up validation, secret files, Settings → Email status and test button |
| [Infrastructure drivers](infrastructure-drivers.md) | `BlobDriverDefinition`, `SecretStoreDriverDefinition`, `QueueDriverDefinition`, `DeploymentDriverDefinition`, `AuditStoreDriverDefinition` | Local volume or S3; local (AES-256-GCM) or AWS Secrets Manager; PostgreSQL or SQS; Compose or ECS; audit store on PostgreSQL or ClickHouse | Selection by one environment variable each, start-up check listing every problem; no product code branches on the driver |
| [Alert conditions](alerts.md#rule-conditions-evaluators) | `EvaluatorDefinition` (`packages/application/src/alerts/evaluators/contract.ts`) | Technical and business conditions: worker floor, queue age, provider errors, latency, token and cost spikes, SLA breaches, escalation rate, CSAT and more | Scheduling, fingerprint dedupe, open/acknowledged/resolved lifecycle, params validation, rule form from JSON Schema |
| [Scheduled tasks](scheduled-tasks.md) | `ScheduledTask` (`apps/worker/src/scheduler/scheduler.service.ts`) | Lease recovery, SLA and offer expiry, auto-assign, alert evaluation, MCP health, retention and more | Leader election across workers, per-task interval, error isolation |
| [Ask OCSO tools](internal-agent-tools.md) | `InternalTool` (`packages/internal-agent/src/contract.ts`) | 12 read and write tools | Per-user tool filtering by permission, re-authorization on every call, confirmation cards for writes, audit |
| [Sign-in and SSO](sign-in-and-sso.md) | No OCSO contract: Better Auth plugins | Password, TOTP with backup codes, passkeys, OIDC, SAML 2.0 | HTTP endpoint allowlist, MFA policy, audit, team and role mapping |

The first six rows are `OcsoPlugin` contributions registered through `FIRST_PARTY_PLUGINS`. Alert
conditions, scheduled tasks and Ask OCSO tools are core-internal registries (their own files above);
they are not plugin contributions yet.

Telemetry export has no in-code contract. The api and worker export OpenTelemetry over OTLP, and you
point the collector (`infra/compose/otel-collector.yaml`) at your backend.

## How a new kind gets in

1. Implement the contract in its own directory of the plugin's package, for example
   `packages/channels/src/<kind>/`, with everything the core and the web app need to know about the
   kind in its descriptor or definition. Keep files small (build rule §2) and export a factory or
   definition.
2. Add it to that package's entry in `FIRST_PARTY_PLUGINS` (`packages/bootstrap/src/first-party.ts`),
   or add a new `OcsoPlugin` entry for a new package. Nothing else registers it; no constant, enum or
   database type lists kinds.
3. Copy the existing contract tests and add your implementation to them.
4. Document the operator setup under `docs/operations/` and the plugin under `docs/plugins/`.
5. Run `pnpm lint`. The plugin-boundary guard learns the new kind from step 2 automatically and fails
   if core code names it.

[add-a-channel.md](add-a-channel.md) walks through this for a channel, end to end.

## Rules every plugin follows

- **Transport only.** Adapters translate between OCSO's canonical types and the outside system. They
  do not write to the database, run the agent loop or decide authorization. The core does those.
- **Validate at the boundary.** Settings and credentials are zod schemas or JSON Schema. Inbound
  payloads are parsed, not trusted (build rule §19).
- **Never leak secrets.** No secret values in errors, logs, validation messages or returned payloads.
  Channel and model adapters scrub provider error text for this (build rule §21).
- **Dependencies are injected.** `fetch`, clocks and SDK clients come in through a deps object from
  the composition root — for channel and alert adapters, the SSRF-guarded egress fetch — so tests run
  offline against recorded provider-shaped responses.
- **Idempotent side effects.** Inbound messages carry a provider message id that the core dedupes on.
  Retries of outbound sends are expected (build rule §20).

## The plugin-boundary guard

`pnpm lint` (`scripts/check-source-guards.mjs`, with `scripts/plugin-boundary.mjs`) fails when core
code names a plugin kind. It derives the vocabulary from the plugins instead of a list:

- the plugin packages are the `name: '@ocso/…'` entries of `FIRST_PARTY_PLUGINS` (a package that is
  itself core, such as `@ocso/agent-runtime`, contributes nothing);
- kinds are the `kind: 'X'` / `kind = 'X'` declarations (upper snake case) in their sources, driver
  names the `driver = 'x'` declarations and the `name: 'x'` of every `*DriverDefinition`.

Core is `apps/api/src`, `apps/worker/src`, `apps/web/{app,components,lib}`, and the `src` of
`application`, `agent-runtime`, `domain`, `db` (schema), `auth`, `events` and `prompt-compiler`; seeds,
tests, e2e, fixtures and migrations are exempt. A quoted kind literal or a per-kind object key in core
fails with `file:line`; a driver name counts only on a line whose code mentions a driver, because
driver names are everyday words (`log`, `local`). A line can opt out with a reasoned comment on it or
the line above — `// plugin-boundary: allow <reason>` — and the guard prints every escape; the goal is
none.

## Where the boundary still leaks

`pnpm lint` lists any core line that still names a kind. Beyond that, these limits are known; do not
copy them as patterns:

- **Contracts live in several packages.** Each internal contract sits in its plugin package; the SDK carries the
  public copy of four of them, kept identical by a CI type guard.
- **Three registries are core-internal.** Alert conditions, scheduled tasks and Ask OCSO tools have
  registries but are not `OcsoPlugin` contributions yet.
- **Driver settings are declared centrally.** `@ocso/config` parses the settings of the first-party
  drivers; a driver from another plugin reads its own settings from `process.env`.
- **Seeds and tests name kinds on purpose.** The demo seed creates a web chat channel and the
  development-only scripted provider; the guard exempts seeds, tests and fixtures.

## Third-party plugins (v0.1)

[`@winsendotai/ocso-plugin-sdk`](../../packages/ocso-plugin-sdk/README.md) is the public, versioned contract
(`apiVersion: 1`). It exports the types for the four kinds open to third parties in v0.1 (**channels, model
providers, alert destinations, email drivers**), `definePlugin`, `pluginError` (errors OCSO translates into its own
typed errors) and `@winsendotai/ocso-plugin-sdk/testing` (`checkPlugin`, the same validations the registries run).
A type-level guard in CI (`packages/bootstrap/test/sdk-conformance.types.ts`) fails when an internal contract drifts
from the SDK, and an agreement test runs `checkPlugin` and the registries over every first-party contribution.
[`examples/ocso-plugin-example-channel`](../../examples/ocso-plugin-example-channel) is a complete plugin built only
on the SDK.

The loader (`packages/bootstrap/src/plugins`) reads `OCSO_PLUGINS` (`name@exactVersion`, comma-separated) and imports
each package from `OCSO_PLUGINS_DIR` (default `/app/plugins`). It refuses to start when the installed version differs
from the pin, the plugin's `apiVersion` is not supported, the name clashes, or a contribution fails validation; the
api, the worker and the seed load the same list and log it, and the System page shows it (`GET /v1/system/plugins`).
See [installing plugins](installing.md) for the derived-image recipe and the trust statement: plugins run in-process
with full trust.

Still internal in v0.1: blob, secrets, queue, deployment and audit-store drivers and tool providers (their contracts
need `@ocso/db` or `@ocso/config`), alert conditions, scheduled tasks and Ask OCSO tools.

## Pages

- [channels.md](channels.md): channel adapters
- [add-a-channel.md](add-a-channel.md): worked example, a Telegram-shaped channel in seven steps
- [model-providers.md](model-providers.md): model provider definitions and adapters
- [tools-and-mcp.md](tools-and-mcp.md): built-in tools, MCP tool servers and the tool authorization path
- [alerts.md](alerts.md): alert delivery destinations and rule conditions
- [email.md](email.md): email drivers
- [infrastructure-drivers.md](infrastructure-drivers.md): blob storage, secret store, queue, deployment, audit store
- [scheduled-tasks.md](scheduled-tasks.md): leader-only periodic work in the worker
- [internal-agent-tools.md](internal-agent-tools.md): tools for Ask OCSO
- [sign-in-and-sso.md](sign-in-and-sso.md): Better Auth sign-in methods and identity providers
