import { NAME, REPO_URL, WINSEN_URL, helloEmail, repo, siteUrl } from '@/content/links';

/** A short, accurate map of the site for language models (the "Ask your AI" links point here). */
const TEXT = `# OCSO — ${NAME}

> Customer success is scattered across channels, tools and teams, with AI bolted on at the edges. OCSO is an open-source (Apache-2.0), self-hosted orchestration layer where named AI agents and human service teams serve customers on WhatsApp, web chat, Slack and Microsoft Teams, with maker–checker approvals on every configuration change and a separate, signed audit store.

OCSO is built by Winsen Labs (${WINSEN_URL}). Code: ${REPO_URL}. Contact: ${helloEmail}. Demos are by request: ${siteUrl}/#demo

## How it works
- Every customer takes one path: channel → router → queue → agent. Routers ask a menu question, classify with a model or use known facts. A queue is the service unit: one AI agent, its human teams, an SLA policy, hours and transfer targets.
- Human hand-off in both directions, with explicit control states: AI active, escalation requested, waiting for a human, human active, AI resuming, resolved. Every change of control is audited.
- Ask OCSO (⌘J / Ctrl+J, or from Slack and Teams): a copilot that acts with the asking user's permissions; every write is a server-built confirmation card; governed changes go to a checker.
- Four role presets checked in code: Tech, Head, Lead, Service; per-user grants with expiry; team-scoped ownership of agents.

## Governance
- Maker–checker: each change to live configuration is a proposal that a named second person approves, bound to content hashes. Stops apply at once.
- Audit events are hash-chained in a separate append-only store (PostgreSQL or ClickHouse), checkpointed with Ed25519 signatures, exported daily and verifiable offline.
- A weekly signed exception report lists where controls were bypassed or failed.

## Build and host
- Plugins: channels, model providers (AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic, Sarvam), alert destinations, email and infrastructure drivers. Tools connect over MCP with OAuth 2.1.
- SDKs: @winsendotai/ocso-plugin-sdk and @winsendotai/ocso-chat live in the repository and are coming to npm (not yet published).
- Deployment: Docker Compose on one host (supported), Terraform for AWS ECS Fargate (validated, not yet applied to a real account). Single-tenant: one deployment per organization.
- Status: pre-1.0; APIs, the schema and plugin contracts can still change. See ${repo('README.md')}.
`;

export function GET() {
  return new Response(TEXT, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
