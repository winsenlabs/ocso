# OCSO Documentation Index

This directory is the canonical product and engineering specification for OCSO.

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
9. [09-HUMAN-OPERATIONS-AND-RBAC.md](09-HUMAN-OPERATIONS-AND-RBAC.md) — Tech Admin, CS Lead, CS Exec, inbox and handoff
10. [10-WORKERS-QUEUES-AND-SCALING.md](10-WORKERS-QUEUES-AND-SCALING.md) — warm conversations, leases, scaling and reliability
11. [11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md](11-OBSERVABILITY-ALERTS-AND-ANALYTICS.md) — role-specific observability and alerting
12. [12-INTERNAL-OCSO-AGENT.md](12-INTERNAL-OCSO-AGENT.md) — internal platform agent
13. [13-DEPLOYMENT-AND-INFRASTRUCTURE.md](13-DEPLOYMENT-AND-INFRASTRUCTURE.md) — Docker Compose and ECS Fargate
14. [14-API-AND-EVENT-CONTRACTS.md](14-API-AND-EVENT-CONTRACTS.md) — API/event contracts and streaming
15. [15-SECURITY-AND-GOVERNANCE.md](15-SECURITY-AND-GOVERNANCE.md) — security boundary, secrets, audit and permissions
16. [16-DELIVERY-PLAN.md](16-DELIVERY-PLAN.md) — phased implementation plan
17. [99-BUILD-RULES.md](99-BUILD-RULES.md) — mandatory engineering rules

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
