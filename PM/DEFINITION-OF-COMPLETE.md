# Definition of complete — evidence

Each operator capability from the build brief, with the automated test that demonstrates it. Browser tests
(`apps/web/e2e/*.spec.ts`) run against the production web build, the built API and a real worker on a
throwaway PostgreSQL database, using the development-only scripted model (ADR-015). Integration tests run
against real PostgreSQL.

| Capability | Evidence | Caveats |
|---|---|---|
| Deploy with Docker Compose | Compose stack built and brought up healthy; web chat → API → worker → reply verified (commit ab1a64a); `docs/operations/compose.md` | Verified on one macOS host with Docker 29 |
| Log in as each user type | `auth-and-roles.spec.ts` (setup, admin, lead, exec, logout); `proxy.spec.ts` | — |
| Create/configure a named virtual agent | `agents.spec.ts` "a CS Lead creates a virtual agent and takes it live"; settings/tools/routing tabs | Business hours display only |
| Configure a supported model provider | `connections.spec.ts` "Tech Admin configures providers…"; provider contract tests for all six (`packages/model-providers/test/contract`) | Real provider calls need customer credentials |
| Create logical model profiles | `connections.spec.ts` "…creates a profile with a fallback after the policy check…"; `packages/application/test/models-profiles.int.test.ts` | — |
| Version and activate prompts | `agents.spec.ts` (edit → version → activate → diff → rollback → replay); `packages/application/test/prompt-versions.int.test.ts` | Only the first activation time is stamped; later activations are in the audit log |
| Connect an MCP tool server | `connections.spec.ts` "…adds the example MCP server: discover → authenticate → classify → approve → healthy"; `packages/application/test/mcp-*.int.test.ts` (OAuth 2.1) | — |
| Connect a customer channel | `connections-channels.spec.ts` (WhatsApp with a real verify-token handshake, web chat); `webchat.spec.ts` | Live WhatsApp needs a Meta number |
| Persistent customer conversation | `webchat.spec.ts` (reply streams, reload resumes); `apps/api/test/int/conversation-flow.int.test.ts` | — |
| Receive multimodal content | `webchat.spec.ts` "the customer uploads an image that the AI receives"; WhatsApp media tests (`packages/channels/test/whatsapp-media.test.ts`); staff attachments (`conversation-flow.int.test.ts`) | — |
| Call external tools safely | `workspace.spec.ts` "a sensitive action the AI proposed is confirmed from the timeline"; `packages/tools/test/authorizer.test.ts`; `packages/agent-runtime/test/human-tools.int.test.ts` | — |
| Escalate to a human | `workspace.spec.ts` "…reaches the AI, then asks for a human"; `webchat.spec.ts` handoff notice | — |
| Auto-assign or open pickup | `workspace.spec.ts` pickup + claim; `packages/application/test/spine.int.test.ts` (claim race, auto-assign, offer expiry) | — |
| CS Exec replies | `workspace.spec.ts` "the exec replies to the customer and the web chat receives it" | — |
| Return conversation to AI | `workspace.spec.ts` "…returns control to the AI, cancels, and resolves"; runtime handover test | — |
| Recover after worker failure | `tests/resilience/chaos-worker-kill.mjs` (SIGKILL mid-turn + SIGTERM drain: every message answered exactly once); `packages/agent-runtime/test/reaper.int.test.ts`, `runtime.int.test.ts` (fencing) | — |
| Technical observability | `system.spec.ts` (control center, workers, alerts, audit); `packages/application/test/telemetry.int.test.ts` | — |
| Business observability | `ops.spec.ts` (analytics, escalation reasons, SLA, reviews, corrections); `agents.spec.ts` analytics; `packages/application/test/analytics.int.test.ts` | — |
| Receive alerts | `system.spec.ts` "…opens a real technical alert, sees its deliveries, acknowledges and resolves it"; `packages/application/test/alerts-*.int.test.ts`; delivery adapter tests | External destinations tested with fakes |
| Use the internal OCSO agent | `internal-agent.spec.ts` (streaming, threads, confirm, role re-check) | — |
| Prompt/cache/token telemetry | Usage events with cache read/write tokens per request (`packages/agent-runtime/src/model/usage-recorder.ts`); telemetry screens in `system.spec.ts`; per-provider cache parameters in provider contract tests | Real cache hit rates need real providers |
| Deploy the same architecture to ECS Fargate | `infra/aws/terraform` (validate/fmt in CI), ECS deployment adapter unit tests (`packages/deployment/test`), `docs/operations/aws.md` | Not yet applied to a real AWS account |
