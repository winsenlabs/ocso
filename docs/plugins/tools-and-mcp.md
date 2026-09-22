# Tools and MCP servers

Tools are the one extension point that needs no OCSO code. A business system exposes its actions as an
MCP server; a Platform Tech Admin connects it in the web app; a CS Lead grants its tools to a virtual
agent. The business system stays a separate application (build rule
[§13](../99-BUILD-RULES.md#13-mcp-servers-remain-external)). OCSO owns the connection, the
credentials and, above all, the decision whether a call may run.

`examples/mcp-bank-demo/` is a complete external MCP server used by the demo seed and the end-to-end
tests. Operator setup is in
[docs/operations/setup-guide.md §4](../operations/setup-guide.md#4-mcp-tool-servers-tech-admin).

## Connecting a server (no code)

**Connections & models → MCP connections → Add MCP server** walks through:

1. **Endpoint.** The server URL. Only `https://`, except `http://` for internal hosts on the egress
   allowlist.
2. **Discover.** OCSO connects with the official MCP TypeScript SDK v2 over Streamable HTTP. It
   negotiates the protocol version, so both 2026-07-28 servers and 2025-era servers work. It then lists
   the tools.
3. **Authenticate.** A static header, or OAuth 2.1. OAuth opens the provider's consent page and
   returns to OCSO.
4. **Classify.** Each tool gets a risk class (`READ`, `WRITE` or `SENSITIVE`) and the human roles that
   may run it from the CS workspace.
5. **Approve.** Which agents may use the connection, the confirmation policy, and whether the server is
   trusted to receive customer identity claims.
6. **Active.** Health is checked on the configured interval.

Tools reach the model as `<connection>__<tool>`, schema only. If the server later changes a tool's
schema, title, description or annotations, OCSO un-approves it until someone reviews it again: the
description is model-visible, so it is a prompt-injection surface.

Users can also connect personal accounts from connection templates an admin publishes (**My
connections**). Agents never use personal connections.

## What the core does on every call

The model only ever proposes a tool call. `ToolRunner` (`packages/agent-runtime/src/tools/runner.ts`)
decides and executes it (ADR-014). Built-in OCSO tools and MCP tools take this one path; nothing is
matched by name:

1. **Authorize in code.** `authorizeToolCall` (`packages/tools/src/authorizer.ts`) is deterministic and
   takes nothing from the model except the arguments. The tool must be approved and enabled, the
   connection usable, the agent granted, the conversation owned by the AI, the scopes present, and the
   arguments valid against the tool's JSON Schema. Then the CS Lead's argument rules run (for example
   "amount above 5,000 needs confirmation", or DENY), then the confirmation policy.
2. **Persist before side effects.** A `tool_calls` row is written with sanitized arguments before
   anything runs.
3. **Confirm when required.** A call that needs confirmation waits for a human's **Confirm and run** in
   the workspace. The arguments that run are exactly the ones shown.
4. **Execute.** The tool-provider registry resolves the provider — the `McpToolProvider` for the
   tool's connection, or the first-party source that ships the tool — and it is called with a timeout.
   Non-read calls carry an idempotency key. Trusted connections also receive a short-lived signed customer identity
   token in `X-OCSO-Customer-Claims` (ES256, 120 s, audience `ocso-mcp:<connection id>`), verifiable
   against `/.well-known/jwks.json`. `examples/mcp-bank-demo/src/claims-jwks.ts` is a complete verifier.
5. **Record and return.** The result is sanitized for audit, truncated for the model, and emitted as
   events for telemetry and alerts.

Around the calls, `packages/mcp` handles:

- **OAuth 2.1**, orchestrated server-side. It prefers Client ID Metadata Documents, then pre-registered
  clients, then dynamic registration. It requires PKCE S256, validates `state` (stored hashed, single
  use) and the RFC 9207 `iss`, and keys credentials by the authorization server's issuer.
- **Egress guard.** Every metadata, token and MCP request goes through an SSRF-guarded `fetch`.
  Private and internal addresses are blocked unless allowlisted.
- **Credentials.** Tokens and headers are kept in the SecretStore. Refresh-token rotation is
  compare-and-swap, so concurrent workers do not lose a rotated token.
- **Health.** `discover()` on 2026 servers, `ping()` on 2025-era servers.

ADR-021 in [PM/ARCHITECTURE-DECISIONS.md](../../PM/ARCHITECTURE-DECISIONS.md) records the decisions,
and [packages/mcp/README.md](../../packages/mcp/README.md) the package details.

## The code-level contract

Inside OCSO, anything that executes tools implements `ToolProvider`
(`packages/tools/src/provider.ts`). A provider runs only after the runtime authorized the call and
wrote its `tool_calls` row; it never authorizes or audits by itself.

```ts
export interface ToolProvider {
  readonly connectionId: string | null;
  invoke(call: ToolInvocation): Promise<ToolOutcome>;
}

export interface ToolInvocation {
  toolCallId: string; toolName: string; args: unknown; timeoutMs: number;
  customerClaims?: string; idempotencyKey?: string; signal?: AbortSignal;
  /** Conversation scope; given to first-party providers only, never to MCP servers. */
  scope?: { conversationId: string; customerId: string; agentId: string; historyWindowStartSeq: number };
}

// SUCCEEDED outcomes may carry a control effect; the runtime honours it from first-party providers only.
export type ToolEffect = { type: 'handoff'; request: HandoffRequest };
```

Providers are grouped into **sources** held by one `ToolProviderRegistry`
(`packages/tools/src/registry.ts`):

```ts
export interface ToolProviderSource {
  readonly kind: string;              // registry key; core code never names one
  readonly connectionBacked: boolean; // true for MCP: tools come from approved `tools` rows per connection
  readonly tools: readonly FirstPartyTool[]; // first-party tools every agent gets; [] for MCP
  provider(connectionId: string | null): Promise<ToolProvider>;
}

export interface FirstPartyTool {
  name: string;                       // model-facing, provider-safe, unique across sources
  description: string;
  inputSchema: Record<string, unknown>;
  riskClass: 'READ' | 'WRITE';        // SENSITIVE is refused: no human-confirmation path in-turn
}
```

`registry.providerFor({ connectionId, name })` returns the connection's provider for MCP tools and the
owning source's provider for first-party tools. `register` refuses a duplicate kind, a second
connection-backed source, a tool name another source already ships, and SENSITIVE first-party tools.

Two sources are registered today, as `toolProviders` in `FIRST_PARTY_PLUGINS`
(`packages/bootstrap/src/first-party.ts`, the composition root):

- **MCP** (`connectionToolSource(MCP_TOOL_SOURCE, new McpToolProviderFactory(…))`; the factory is in
  `packages/bootstrap/src/tool-providers.ts`): one pooled provider per connection, rebuilt when the
  connection changes.
- **Built-in OCSO tools** (`createBuiltinToolSource(db)`,
  `packages/agent-runtime/src/tools/builtins.ts`): `ocso_request_handoff` (WRITE; its outcome carries a
  `handoff` effect the turn applies) and `ocso_search_history` (READ; reads the customer's older
  messages through the call's `scope`).

`createRuntimeToolRegistry(db, secrets, settings, plugins)` (`packages/bootstrap/src/tools.ts`)
registers every plugin's sources; the worker's `ToolRunner` and the api's `HumanToolService` (workspace
"Confirm and run" and human-run tools) resolve providers through it. Tests build one with
`createToolProviderRegistry(db, …extraSources)` from `@ocso/agent-runtime` (built-ins plus, e.g., a fake
`connectionToolSource`).

**Built-in tools are authorized and audited like MCP tools.** The catalog
(`loadAgentToolCatalog`) gives every agent the first-party tools as approved, enabled tools with an
implicit grant (no argument rules, no forced confirmation); each call still passes `authorizeToolCall`
— the AI must own the conversation and the arguments must match the tool's JSON Schema — and writes a
`tool_calls` row (`tool_id` and `connection_id` null, `tool_name` = the model-facing name). An MCP tool
can never shadow a first-party name.

To give agents a capability that lives in another system, expose it as an MCP server. That is the
intended path, not a workaround. First-party sources are for tools that act on OCSO's own state.

## Tests to copy

- `packages/mcp/test/`: discovery, OAuth, egress, health and the tool provider against an in-process
  MCP server.
- `packages/tools/test/authorizer.test.ts`: every authorization rule; `registry.test.ts`: provider
  resolution and registration rules.
- `packages/agent-runtime/test/builtin-tools.int.test.ts`: built-in tools denied and audited through
  the same path as MCP tools, effects ignored from external providers, no shadowing.
- `packages/application/test/mcp-connections.int.test.ts`, `mcp-oauth.int.test.ts`,
  `mcp-personal.int.test.ts`: the connection lifecycle on PostgreSQL.
- `packages/agent-runtime/test/human-tools.int.test.ts`: confirmations and human-run tools.
- `apps/api/test/int/mcp.int.test.ts`, `mcp-tool-providers.int.test.ts`: through the real API.

## Limits today

- Streamable HTTP only. There is no stdio transport.
- First-party tools have no `tools` rows, so a CS Lead cannot revoke them per agent or attach argument
  rules to them; the implicit grant always applies. Persisting them as records would need a data
  migration.
- The catalog takes its first-party tool list as a parameter (default: the built-ins); a registry with
  extra first-party sources must pass `registry.firstPartyTools()` where the catalog is built.
- Known gap (ADR-021): a worker that loses a token-refresh race may fail one call before it re-reads
  the rotated tokens.
