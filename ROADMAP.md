# Roadmap

OCSO is pre-1.0. This page lists what we plan next and the known gaps we would welcome help with. It is
drawn from the build plan ([PM/BUILD-PLAN.md](PM/BUILD-PLAN.md)), the "Not in v1" sections of the plugin
guides and the open points in the [architecture decision records](PM/ARCHITECTURE-DECISIONS.md).
The order within a section is not a commitment.

Want to pick something up? Comment on the matching issue (or open one) before you start, so the approach
can be agreed. [CONTRIBUTING.md](CONTRIBUTING.md) has the rules and the test layers.

## Towards 1.0

- **Publish the SDKs to npm.** `@winsendotai/ocso-plugin-sdk`, `@winsendotai/ocso-chat` and
  `@winsendotai/ocso-chat-react` are built and tested here (ADR-034) but not published yet. This needs a
  release workflow with provenance, versioning, and a compatibility check between the SDK's API version and
  the server.
- **Tagged releases and prebuilt images.** Today you build the images yourself (`docker compose build`).
  We plan versioned releases with images on a public registry and release notes that call out migrations
  which are not expand/contract.
- **Run the Ask OCSO evals against a real model.** The 83-scenario suite
  (`packages/internal-agent/evals/`, `pnpm evals:ask-ocso`) exists. The run against
  a real provider, and publishing its results, are pending.
- **Live verification of the integrations.** Model providers, both WhatsApp integrations, message
  templates and model discovery (Vertex and Bedrock listings) are tested offline against recorded
  provider-format responses. They need checking against live accounts. The checklist for WhatsApp is in
  [packages/channels/README.md](packages/channels/README.md). Sarvam's prompt caching is unverified.
- **Make the Playwright job blocking in CI.** It runs on every pull request but does not block merges yet.
- **A single `pnpm dev`** that runs the api, the worker and the web app from source against a local
  database, with the demo seed.

## Channels

- **Files and media on Slack and Microsoft Teams.** Both channels read and send text and choice buttons
  only. Slack needs `files:write` and its two-step upload. Teams needs the file consent flow or SharePoint
  links. See the "Not in v1" sections of [slack.md](docs/plugins/slack.md) and
  [ms-teams.md](docs/plugins/ms-teams.md).
- **Smaller Slack and Teams gaps.** Slack display names through `users.info`, proactive Teams messages,
  and updating a sent Teams card after a tap.
- **Agent audience: internal and external.** Today a Slack or Teams channel either serves customers
  through a virtual agent, or takes staff to Ask OCSO. We want audience (your own staff or your
  customers) to be an explicit property of agents and channels, with identity, rendering and data rules
  to match, so an agent can serve employees as well as customers.
- **New channels.** SMS, RCS and voice are reserved kinds with no adapter. Each one is a plugin
  ([add a channel](docs/plugins/add-a-channel.md)).

## Governance and security

- **Two approval rules awaiting a decision** (ADR-030, deviations 10 and 11): whether Service members see
  their team's proposals read-only, and whether a platform-wide fallback checker is used when nobody in
  the owning teams can check. Both are built and work as documented today.
- **Audit exports on write-once storage.** OCSO does not configure or check S3 Object Lock on
  `audit-exports/`. A start-up check (or a Terraform setting) would close that gap.
- **Sign-in.** Email one-time codes as a second factor, and "SSO only" enforcement per email domain.

## Deployment

- **AWS.** The ECS Fargate Terraform (`infra/aws/terraform`) passes `terraform validate` but has never
  been applied to a real account. It does not yet wire the Better Auth secret or email, and the audit
  store additions (a second RDS instance, bootstrap keys, the signing-key secret) are unvalidated.
  See [aws.md §10](docs/operations/aws.md#10-known-gaps-and-follow-ups).
- **MCP over stdio.** OCSO speaks Streamable HTTP only. A stdio transport (for example through a sidecar)
  would let you connect local MCP servers.

## The plugin boundary

From [docs/plugins/README.md](docs/plugins/README.md#where-the-boundary-still-leaks):

- Alert conditions, scheduled tasks and Ask OCSO tools have registries but are not `OcsoPlugin`
  contributions yet, so third-party plugins cannot add them.
- The settings of first-party drivers are parsed centrally in `@ocso/config`. A driver from another plugin
  reads its own settings from `process.env`. A per-plugin settings schema would fix that.

## Good first issues

These are self-contained, well-specified and touch one area each:

- Split one of the files that `pnpm lint` reports as over 300 lines, along a clear responsibility line.
- Slack display names: look up `users.info` once per user and cache it (docs/plugins/slack.md).
- Add an S3 Object Lock check for `audit-exports/` to the System page's audit store panel.
- Add a new alert destination (for example Opsgenie or a Discord webhook) behind the
  `AlertDeliveryAdapter` contract ([alerts.md](docs/plugins/alerts.md)).
- Add a new email driver (for example Amazon SES or Postmark) behind the email contract
  ([email.md](docs/plugins/email.md)).
- Improve a runbook in `docs/operations/` after following it on a fresh machine, and fix whatever did not
  match.
