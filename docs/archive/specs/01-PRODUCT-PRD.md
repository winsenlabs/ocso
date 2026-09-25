# Product Requirements Document

> [!IMPORTANT]
> **Original design spec (2026-09): parts are superseded; see [architecture.md](../../concepts/architecture.md), [virtual-agents.md](../../concepts/virtual-agents.md), [conversations.md](../../concepts/conversations.md), [routing.md](../../concepts/routing.md).** This page is kept for history. Where it and the code disagree, the code and [PM/ARCHITECTURE-DECISIONS.md](../../../PM/ARCHITECTURE-DECISIONS.md) win. Links inside it may point to pages that have since moved.

## 1. Product

**Name:** OCSO — Open Customer Success Orchestration

**Purpose:** Let an organization deploy and operate named external-facing AI employees for customer service, sales and adjacent customer conversations, while preserving seamless human intervention, enterprise tool access and production observability.

## 2. Deployment and tenancy

OCSO is **single-tenant, multi-user**.

A deployment belongs to one organization. It may contain:
- many human users
- many named virtual agents
- many customer identities
- many channels
- many queues and teams
- many MCP/tool connections
- many conversations

The core schema and runtime must not be designed as a multi-tenant SaaS platform. There is no tenant selector and no tenant switching. If two organizations require OCSO, they receive separate deployments.

## 3. Primary users

> As built (ADR-029): the three roles below are now four presets. Platform Tech Admin → **Tech**, CS Lead →
> **Head** (with **Lead** as a narrower preset that proposes but cannot approve), CS Exec → **Service**.
> Configuration changes are approved by a second person (ADR-030).

### Tech (formerly Platform Tech Admin)
Owns technical configuration and reliability:
- deployment health
- workers and concurrency
- model providers
- credentials and secrets
- channels
- MCP connections
- authentication
- infrastructure configuration
- telemetry, token usage, latency and uptime
- technical alerts

### Head and Lead (formerly CS Lead)
Owns business operations:
- virtual-agent setup
- prompt/instruction configuration
- queues and assignment rules
- escalation rules
- SLAs
- quality review
- agent performance
- prompt corrections
- business alerts
- analytics
- Service access and team setup

### Service (formerly CS Exec)
Owns customer handling when a human is needed:
- see permitted conversations
- claim open conversations
- accept assignments
- respond to customers
- inspect history and context
- add internal notes
- use permitted tools
- return control to AI
- resolve conversations

## 4. Virtual agents

OCSO can host multiple named virtual agents, for example:
- Maya — Customer Support
- Arjun — Sales
- Riya — Collections

Each agent has its own:
- name and identity
- purpose
- prompt configuration
- model policy
- enabled tools
- knowledge/context sources
- channel assignments
- escalation policy
- queues/team
- business hours
- multimodal capabilities
- analytics

A virtual agent is not a worker. Many agents may execute over the same worker pool.

## 5. Conversation types

The same underlying conversation model supports multiple business purposes:
- customer service
- sales
- collections
- onboarding
- custom external-facing workflows

Conversation type changes business instructions, routing, KPIs and analytics, but not the core runtime.

## 6. AI ownership and human intervention

AI handles the full conversation by default.

Handoff can be triggered by:
- customer request
- agent decision
- policy
- intent
- risk condition
- repeated tool failure
- SLA rule
- low-confidence/quality rule where configured
- business-specific conditions

Handoff modes:
1. **Auto-assign** to an eligible available Service member.
2. **Open pickup** into a visible team inbox for an eligible Service member to claim.

Human takeover does not terminate the agent session. The agent remains attached to the conversation and can resume when the human returns control.

## 7. Multimodality

OCSO must model interactions, not text-only messages.

Supported canonical interaction parts should include:
- text
- image
- audio
- video
- document
- location
- contact
- structured payload
- tool result/system metadata

A single user turn may include multiple parts.

## 8. Channels

Channel adapters normalize external transport into canonical OCSO interactions and render OCSO output back into channel capabilities.

Initial/important targets include:
- WhatsApp
- web chat
- custom web/mobile frontend

The architecture must permit later Slack/Teams/RCS/SMS/voice/other adapters without changing the agent kernel.

Channels control what is rendered. WhatsApp may expose only customer-safe responses. Internal surfaces may expose citations, tool progress or structured status.

## 9. Tools

Business systems are external applications. OCSO consumes approved capabilities through MCP/tool servers.

OCSO must support:
- admin-level/shared tool connections
- user-level/personal tool connections where permitted
- OAuth-based MCP connection setup
- token lifecycle handling
- tool discovery
- connection health
- per-agent tool permission policy
- short-lived authenticated claims toward trusted tool servers

The model must never receive raw master credentials.

## 10. Model providers

OCSO must support a provider adapter layer for:
- AWS Bedrock
- Google Vertex AI
- Microsoft Foundry
- OpenAI API
- Anthropic API
- Sarvam API
- future compatible providers

Provider and logical model profile are separate concepts.

## 11. Internal OCSO agent

The product includes an internal agent that can navigate OCSO through the same permissioned control-plane APIs used by the UI.

Examples:
- "What needs my attention?"
- "Why did latency spike?"
- "Which agent is escalating most often?"
- "Show conversations where Maya struggled with refunds."
- "Which MCP connection is failing?"
- "Increase warm workers from 2 to 4." (only if user permissions and action confirmation policy permit it)

The internal agent must inherit the logged-in user's RBAC.

## 12. Observability

Observability is role-specific.

Tech:
- uptime
- service health
- worker health/capacity
- queue depth
- concurrency
- model/provider latency
- token usage
- prompt-cache read/write metrics
- tool latency/errors
- MCP health
- error/retry rate
- cost/usage
- traces and logs

Head and Lead:
- resolution/containment
- escalation rate
- handoff reasons
- SLA compliance
- quality review
- prompt correction opportunities
- tool/business failure patterns
- knowledge gaps
- sales/service outcome metrics
- conversation trends

Service:
- assigned/open conversations
- waiting customers
- priority/escalation state
- own workload and relevant customer context

## 13. Alerts

Alerts are first-class, configurable and role-aware.

Alert targets include in-app plus pluggable external delivery such as email, Slack/Teams, webhook and pager-style integrations.

Rules may be technical or business-oriented and may be global or virtual-agent-specific.

## 14. Non-goals for initial build

- multi-tenant SaaS control plane
- generic coding agent
- embedded CRM/ERP/core banking implementation
- arbitrary browser/computer execution by default
- replacing external business systems
- complex workflow-builder UI before core runtime is stable

## 15. Top-level acceptance criteria

A production-ready first release should allow an operator to:
1. Deploy OCSO with Docker Compose on one EC2 host.
2. Deploy the same application topology on ECS Fargate.
3. Create users with the three roles.
4. Create and name a virtual agent.
5. Configure a supported LLM provider/model profile.
6. Configure the agent prompt.
7. Connect at least one customer channel.
8. Connect an MCP/tool server.
9. Receive and respond to a multimodal customer conversation.
10. Execute tools through the agent.
11. Escalate to a human via auto-assignment or pickup queue.
12. Resume AI after human intervention.
13. Inspect role-appropriate observability.
14. Receive and resolve alerts.
15. Use the internal OCSO agent to inspect the platform.
16. Persist and recover conversations across worker failure/restart.
17. Measure provider prompt-cache and OCSO turn-cache behavior.
