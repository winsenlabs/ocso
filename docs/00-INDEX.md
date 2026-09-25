# OCSO Documentation Index

This directory is the canonical product and engineering specification for OCSO (Open Customer Success
Orchestration). New here? Start with the [README](../README.md), run the demo, then read
[CONTRIBUTING.md](../CONTRIBUTING.md) before your first pull request.

The numbered documents are the original specification. Where the code refined them, an ADR in
[PM/ARCHITECTURE-DECISIONS.md](../PM/ARCHITECTURE-DECISIONS.md) records the change, and an
"Implementation notes (as built)" section says what was built.

OCSO is a **single-tenant, multi-user** application. One deployment belongs to one organization. Do not introduce SaaS-style tenant isolation, tenant switching, tenant IDs, or cross-tenant abstractions into the core product.

## Read in this order

1. [01-PRODUCT-PRD.md](01-PRODUCT-PRD.md) — product scope, personas, use cases and acceptance criteria
2. [02-SYSTEM-ARCHITECTURE.md](02-SYSTEM-ARCHITECTURE.md) — runtime boundaries and major services
3. [03-DOMAIN-AND-DATA-MODEL.md](03-DOMAIN-AND-DATA-MODEL.md) — canonical entities and PostgreSQL model
4. [04-AGENT-RUNTIME.md](04-AGENT-RUNTIME.md) — conversation execution, turns, tools and state
5. [05-PROMPTS-AND-CACHING.md](05-PROMPTS-AND-CACHING.md) — prompt compiler, prompt caching and turn caching
6. [06-MODEL-PROVIDERS.md](06-MODEL-PROVIDERS.md) — provider abstraction and supported providers
7. [07-CHANNELS-AND-MULTIMODAL.md](07-CHANNELS-AND-MULTIMODAL.md) — WhatsApp/web/other channels and canonical interactions
8. [08-MCP-TOOLS-AND-AUTH.md](08-MCP-TOOLS-AND-AUTH.md) — tool servers, OAuth, JWT claims and connection scopes
9. [09-HUMAN-OPERATIONS-AND-RBAC.md](09-HUMAN-OPERATIONS-AND-RBAC.md) — presets Tech, Head, Lead, Service; per-user permissions; inbox and handoff
10. [10-WORKERS-QUEUES-AND-SCALING.md](10-WORKERS-QUEUES-AND-SCALING.md) — warm conversations, leases, scaling and reliability
11. [11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md](11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md) — role-specific observability and alerting
12. [12-INTERNAL-OCSO-AGENT.md](12-INTERNAL-OCSO-AGENT.md) — internal platform agent
13. [13-DEPLOYMENT-AND-INFRASTRUCTURE.md](13-DEPLOYMENT-AND-INFRASTRUCTURE.md) — Docker Compose and ECS Fargate
14. [14-API-AND-EVENT-CONTRACTS.md](14-API-AND-EVENT-CONTRACTS.md) — API/event contracts and streaming
15. [15-SECURITY-AND-GOVERNANCE.md](15-SECURITY-AND-GOVERNANCE.md) — security boundary, secrets, audit and permissions
16. [16-DELIVERY-PLAN.md](16-DELIVERY-PLAN.md) — phased implementation plan
17. [99-BUILD-RULES.md](99-BUILD-RULES.md) — mandatory engineering rules

## Plugins and extension points

- [plugins/README.md](plugins/README.md) — what "plugin" means in OCSO, every extension point, and where the boundary leaks
- [plugins/channels.md](plugins/channels.md) — channel adapters
- [plugins/add-a-channel.md](plugins/add-a-channel.md) — worked example: add a channel in seven steps
- [plugins/slack.md](plugins/slack.md) — the Slack channel
- [plugins/ms-teams.md](plugins/ms-teams.md) — the Microsoft Teams channel
- [plugins/installing.md](plugins/installing.md) — installing third-party plugins (`OCSO_PLUGINS`) and the plugin SDK
- [plugins/model-providers.md](plugins/model-providers.md) — model provider definitions and adapters
- [plugins/tools-and-mcp.md](plugins/tools-and-mcp.md) — MCP tool servers and tool authorization
- [plugins/alerts.md](plugins/alerts.md) — alert delivery destinations and rule conditions
- [plugins/email.md](plugins/email.md) — email senders
- [plugins/infrastructure-drivers.md](plugins/infrastructure-drivers.md) — blob storage, secret store, queue, deployment
- [plugins/scheduled-tasks.md](plugins/scheduled-tasks.md) — leader-only periodic work
- [plugins/internal-agent-tools.md](plugins/internal-agent-tools.md) — tools for Ask OCSO
- [plugins/sign-in-and-sso.md](plugins/sign-in-and-sso.md) — sign-in methods and identity providers

## Operations

- [operations/compose.md](operations/compose.md) — running OCSO with Docker Compose
- [operations/setup-guide.md](operations/setup-guide.md) — from an empty deployment to a live virtual agent
- [operations/worker-scaling.md](operations/worker-scaling.md) — worker scaling on Compose and ECS
- [operations/resilience-testing.md](operations/resilience-testing.md) — chaos and load scripts
- [operations/ask-ocso-in-chat.md](operations/ask-ocso-in-chat.md) — Ask OCSO from Slack and Microsoft Teams (account linking)
- [operations/aws.md](operations/aws.md) — ECS Fargate with Terraform (not yet applied to a real account)

## Planning and decisions

- [../PM/ARCHITECTURE-DECISIONS.md](../PM/ARCHITECTURE-DECISIONS.md) — architecture decision records (ADRs)
- [../PM/BUILD-PLAN.md](../PM/BUILD-PLAN.md) — the build plan, status per epic and the change log
- [../PM/DEFINITION-OF-COMPLETE.md](../PM/DEFINITION-OF-COMPLETE.md) — each operator capability from the build brief, with the test that demonstrates it
- [../PM/research/](../PM/research/) — the technical research behind the decisions (SDKs, providers, WhatsApp, MCP, auth, governance)
- [../ROADMAP.md](../ROADMAP.md) — what is planned next and the known gaps

## Product definition

OCSO is an open-source runtime for external-facing AI employees. It is not a generic internal-agent platform, not a CRM, and not a business-system replacement.

OCSO runs the customer-facing conversation and the humans who may intervene in that conversation. External systems remain outside OCSO and expose approved capabilities through MCP/tool adapters.

## Design principles

- One deployment, one organization, many users.
- One deployment may run many named virtual agents.
- Virtual agents are logical entities; workers are infrastructure capacity.
- AI owns the conversation by default.
- Human takeover is seamless and reversible.
- Channels, models, tools and telemetry sinks are adapters/plugins.
- PostgreSQL is durable truth.
- Workers are replaceable executors.
- The same logical application must run on one EC2 host with Docker Compose or on ECS Fargate.
- Business and technical observability are different user experiences.
- Alerts are first-class.
- Prompt and turn caching are first-class.
- No large monolithic source files. See build rules.
