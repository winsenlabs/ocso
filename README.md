# OCSO — Open Customer Service Orchestrator

OCSO is an open-source runtime for building and operating external-facing AI employees for customer service, sales, collections, onboarding, and other customer-facing workflows.

A single OCSO deployment is **single-tenant and multi-user**. It belongs to one organization, supports many platform users and many named virtual agents, and connects to external business systems through MCP/tool servers.

OCSO owns the interaction and orchestration layer:
- customer identity and channels
- multimodal conversations
- virtual-agent runtime
- model/provider abstraction
- prompt compilation and caching
- MCP/tool connectivity
- human handoff and CS workspaces
- queues, assignments and routing
- role-aware observability
- alerts and incidents
- internal OCSO administration agent
- deployment and scaling

Business systems remain separate applications and expose capabilities to OCSO over MCP or another approved tool adapter.

## Core stack

- Backend: NestJS
- Frontend: Next.js
- Database: PostgreSQL
- Agent/model runtime: Vercel AI SDK
- Chat UI/runtime integration: Vercel Chat SDK
- Containers: Docker
- Small deployment: one EC2 host with Docker Compose
- Scaled deployment: ECS Fargate
- Model providers: AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI API, Anthropic API, Sarvam API, plus future provider plugins
- External capabilities: MCP

## Documentation

Start with [docs/00-INDEX.md](docs/00-INDEX.md).

The documentation is intentionally implementation-oriented so a new engineer or coding agent can pick up the repository and build OCSO without needing hidden product context.

The final and mandatory engineering constraints are in [docs/99-BUILD-RULES.md](docs/99-BUILD-RULES.md).