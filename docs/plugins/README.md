# Plugins and extension points

OCSO is a core plus a set of contracts. The core owns what every deployment needs: the conversation
runtime, human handoff, roles and permissions, audit, queues and leases, and observability. Everything
that touches an outside system sits behind a contract and is looked up in a registry: customer
channels, model providers, tool servers, email, blob storage, secrets, alert destinations and
conditions, scheduled tasks, and the tools of the internal agent.

This page defines what "plugin" means in this repository, lists every extension point that exists
today, and says where the boundary still leaks.

## What "plugin" means here

A plugin is an implementation of a TypeScript contract that the core looks up by kind in a registry.
Core code asks the registry for "the adapter for `TWILIO_WHATSAPP`" and calls the contract. It never
switches on the kind. The build rules require this: avoid "huge switch statements for every
provider/channel/tool" ([§2](../99-BUILD-RULES.md#2-no-large-monolith-files)) and keep external
implementations behind adapters ([§4](../99-BUILD-RULES.md#4-pluginsadapters-at-external-boundaries)).

Be precise about what this is and is not:

- **Plugins are compile-time and in-repo.** Each implementation lives in a workspace package under
  `packages/`, and one line of composition code registers it. There is no loader that reads a list of
  npm packages from configuration. All workspace packages are `"private": true` and unpublished.
- **Kinds are closed TypeScript unions.** Adding a channel, model provider or alert destination kind
  also means adding it to a constant (`CHANNEL_KINDS`, `PROVIDER_KINDS`, `DESTINATION_KINDS`).
  The database does not constrain kinds: the `kind` columns are `text`, so no migration is needed.
- **Kinds are code, instances are configuration.** A kind (say, WhatsApp via Twilio) is compiled in.
  An instance of it (your WhatsApp number, with its credentials) is created by a Platform Tech Admin
  in the web app, stored in PostgreSQL, and its secrets go to the SecretStore.
- **Two extension points need no code at all.** Any MCP server can be connected at runtime from the
  web app ([tools-and-mcp.md](tools-and-mcp.md)), and OIDC or SAML identity providers are added the
  same way ([sign-in-and-sso.md](sign-in-and-sso.md)).

## Extension points

| Extension point | Contract | Shipped implementations | Registered in | What the core does for you |
|---|---|---|---|---|
| [Channels](channels.md) | `ChannelAdapter`, `ChannelKindDescriptor` in `packages/channels/src/contract/types.ts` | WhatsApp via Twilio, WhatsApp via Meta Cloud API, web chat | `packages/bootstrap/src/channels.ts` | Webhook route per kind, persist-before-ack ingress with dedupe, identity resolution, media fetch jobs, customer-safe rendering filter, delivery retries, admin form from JSON Schema, encrypted secrets |
| [Model providers](model-providers.md) | `ProviderDefinition` in `packages/model-providers/src/providers/definition.ts`, `ModelProviderAdapter` in `contract/types.ts` | AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic, Sarvam (plus a development-only scripted provider) | `packages/model-providers/src/registry.ts` | Shared AI SDK call path, usage and error normalization, secret scrubbing, health checks, admin form from zod schemas, profiles with fallbacks and policy checks, cost telemetry |
| [Tool servers (MCP)](tools-and-mcp.md) | Any MCP server over Streamable HTTP; internally `ToolProvider` in `packages/tools/src/provider.ts` | `McpToolProvider` in `packages/mcp` | Runtime: added in the web app | Discovery, OAuth 2.1 or static-header auth, risk classification and approval, authorization in code, human confirmation, SSRF-guarded egress, health checks, audit |
| [Alert destinations](alerts.md#delivery-destinations) | `AlertDeliveryAdapter` in `packages/alerts/src/contract.ts` | In-app, email, Slack, Microsoft Teams, signed webhook, PagerDuty | `packages/alerts/src/registry.ts` | Dispatch per lifecycle event, retries with backoff, encrypted secrets, test button |
| [Alert conditions](alerts.md#rule-conditions-evaluators) | `EvaluatorDefinition` in `packages/application/src/alerts/evaluators/contract.ts` | Technical and business conditions: worker floor, queue age, provider errors, latency, token and cost spikes, SLA breaches, escalation rate, CSAT and more | `packages/application/src/alerts/evaluators/registry.ts` | Scheduling, fingerprint dedupe, open/acknowledged/resolved lifecycle, params validation, rule form from JSON Schema |
| [Email senders](email.md) | `EmailSender` in `packages/email/src/contract.ts` | Resend, SMTP, log (development) | `packages/email/src/config.ts` | Typed templates, start-up validation, Settings → Email status and test button |
| [Infrastructure drivers](infrastructure-drivers.md) | `BlobStore`, `SecretStore`, `QueueAdapter`, `DeploymentAdapter` | Local volume or S3; local (AES-256-GCM) or AWS Secrets Manager; PostgreSQL or SQS; Compose or ECS | `packages/bootstrap/src/adapters.ts`, `deployment.ts` | Selection by one environment variable each; no product code branches on the driver |
| [Scheduled tasks](scheduled-tasks.md) | `ScheduledTask` in `apps/worker/src/scheduler/scheduler.service.ts` | Lease recovery, SLA and offer expiry, auto-assign, alert evaluation, MCP health, retention and more | `scheduler.service.ts`, `tasks.registry.ts` | Leader election across workers, per-task interval, error isolation |
| [Ask OCSO tools](internal-agent-tools.md) | `InternalTool` in `packages/internal-agent/src/contract.ts` | 12 read and write tools | `packages/internal-agent/src/registry.ts` | Per-user tool filtering by permission, re-authorization on every call, confirmation cards for writes, audit |
| [Sign-in and SSO](sign-in-and-sso.md) | No OCSO contract: Better Auth plugins | Password, TOTP with backup codes, passkeys, OIDC, SAML 2.0 | `packages/application/src/identity/auth/server.ts` | HTTP endpoint allowlist, MFA policy, audit, team and role mapping |

Telemetry export has no in-code contract. The api and worker export OpenTelemetry over OTLP, and you
point the collector (`infra/compose/otel-collector.yaml`) at your backend.

## How a new kind gets in

For the registry-based points (channels, model providers, alert destinations), the steps are the same
shape:

1. Add the kind to its constant (`CHANNEL_KINDS`, `PROVIDER_KINDS` or `DESTINATION_KINDS`). Also add
   it to the matching `$type<…>` union in `packages/db/src/schema/*.ts`. That union is TypeScript only;
   the column is `text`, so there is no migration.
2. Implement the contract in its own directory, for example `packages/channels/src/<kind>/`. Keep
   files small (build rule §2) and export a factory.
3. Register it with one line in the composition code (see the table).
4. Copy the existing contract tests and add your implementation to them.
5. Document the operator setup under `docs/operations/` and the plugin under `docs/plugins/`.

[add-a-channel.md](add-a-channel.md) walks through this for a channel, end to end.

## Rules every plugin follows

- **Transport only.** Adapters translate between OCSO's canonical types and the outside system. They
  do not write to the database, run the agent loop or decide authorization. The core does those.
- **Validate at the boundary.** Settings and credentials are zod schemas. Inbound payloads are parsed,
  not trusted (build rule §19).
- **Never leak secrets.** No secret values in errors, logs, validation messages or returned payloads.
  Channel and model adapters scrub provider error text for this (build rule §21).
- **Dependencies are injected.** `fetch`, clocks and SDK clients come in through a deps object, so tests
  run offline against recorded provider-shaped responses.
- **Idempotent side effects.** Inbound messages carry a provider message id that the core dedupes on.
  Retries of outbound sends are expected (build rule §20).

## Where the boundary leaks today

The registries are real, but some code outside them still knows specific kinds. These are known and
tracked for removal; do not copy them as patterns.

- **Closed kind lists.** `CHANNEL_KINDS`, `PROVIDER_KINDS` and `DESTINATION_KINDS` are closed unions, and
  the registries are typed on them. Model provider and alert destination inputs are validated against
  the constant (`z.enum`), not against the registry. Channel inputs are validated against the registry.
- **Web app labels and forms.** Channel and provider logo marks, some labels, provider caching
  descriptions and the per-provider setup steps are hard-coded maps in `apps/web`. The alert destination
  form is fully hand-written per kind, because `AlertDeliveryAdapter` carries no config schema. Channel
  and model provider forms, by contrast, are rendered from the plugin's schema.
- **Web chat is more than an adapter.** Its customer API (`apps/api/src/modules/webchat`), its widget
  (`apps/web/components/webchat`, `apps/web/public/ocso-webchat.js`) and its CSAT endpoint are core
  code that only serves the `WEBCHAT` kind. A second embeddable channel would need its own API module
  and UI.
- **Built-in agent tools.** The handoff and history-search tools are matched by name in
  `packages/agent-runtime/src/tools/runner.ts`, not provided through `ToolProvider`. Tool providers are
  resolved only per MCP connection.
- **Defaults that name a kind.** A few fallbacks and previews assume `WEBCHAT` or `WHATSAPP`
  (prompt preview, context builder, evaluation replay).

## Roadmap: third-party plugins

The next piece after this documentation is a plugin SDK, to be published as
`@winsendotai/ocso-plugin-sdk`. It does not exist yet. The plan is a stable, versioned package that
exports the plugin contracts, plus a loader that registers plugin packages named in configuration.
That is what lets a third party ship a channel or model provider as its own npm package without
forking OCSO.

Until it ships, plugins live in this repository and are registered at compile time, as described
above. To propose one, open a "New plugin proposal" issue.

## Pages

- [channels.md](channels.md): channel adapters
- [add-a-channel.md](add-a-channel.md): worked example, a Telegram-shaped channel in seven steps
- [model-providers.md](model-providers.md): model provider definitions and adapters
- [tools-and-mcp.md](tools-and-mcp.md): MCP tool servers and the tool authorization path
- [alerts.md](alerts.md): alert delivery destinations and rule conditions
- [email.md](email.md): email senders
- [infrastructure-drivers.md](infrastructure-drivers.md): blob storage, secret store, queue, deployment
- [scheduled-tasks.md](scheduled-tasks.md): leader-only periodic work in the worker
- [internal-agent-tools.md](internal-agent-tools.md): tools for Ask OCSO
- [sign-in-and-sso.md](sign-in-and-sso.md): Better Auth sign-in methods and identity providers
