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
decides and executes it (ADR-014):

1. **Authorize in code.** `authorizeToolCall` (`packages/tools/src/authorizer.ts`) is deterministic and
   takes nothing from the model except the arguments. The tool must be approved and enabled, the
   connection usable, the agent granted, the conversation owned by the AI, the scopes present, and the
   arguments valid against the tool's JSON Schema. Then the CS Lead's argument rules run (for example
   "amount above 5,000 needs confirmation", or DENY), then the confirmation policy.
2. **Persist before side effects.** A `tool_calls` row is written with sanitized arguments before
   anything runs.
3. **Confirm when required.** A call that needs confirmation waits for a human's **Confirm and run** in
   the workspace. The arguments that run are exactly the ones shown.
4. **Execute.** The `McpToolProvider` for that connection is called with a timeout. Non-read calls
   carry an idempotency key. Trusted connections also receive a short-lived signed customer identity
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
(`packages/tools/src/provider.ts`):

```ts
export interface ToolProvider {
  readonly connectionId: string | null;
  invoke(call: ToolInvocation): Promise<ToolOutcome>;
}
```

The runtime gets providers from a `ToolProviderFactory` keyed by MCP connection id
(`forConnection(connectionId)`). The production factory is `McpToolProviderFactory` in
`packages/bootstrap/src/tool-providers.ts`, which pools one provider per connection and rebuilds it
when the connection changes.

There is no registry of non-MCP tool providers. To give agents a new capability, expose it as an MCP
server. That is the intended path, not a workaround.

## Tests to copy

- `packages/mcp/test/`: discovery, OAuth, egress, health and the tool provider against an in-process
  MCP server.
- `packages/tools/test/authorizer.test.ts`: every authorization rule.
- `packages/application/test/mcp-connections.int.test.ts`, `mcp-oauth.int.test.ts`,
  `mcp-personal.int.test.ts`: the connection lifecycle on PostgreSQL.
- `packages/agent-runtime/test/human-tools.int.test.ts`: confirmations and human-run tools.
- `apps/api/test/int/mcp.int.test.ts`, `mcp-tool-providers.int.test.ts`: through the real API.

## Limits today

- Streamable HTTP only. There is no stdio transport.
- The two built-in agent tools, `ocso_request_handoff` and `ocso_search_history`
  (`packages/agent-runtime/src/tools/builtins.ts`), are matched by name in `ToolRunner.run`. They do not
  go through `ToolProvider` or `authorizeToolCall`, and do not write `tool_calls` rows; a handoff is
  recorded through the escalation it starts. Adding another built-in tool means editing the runner.
- Known gap (ADR-021): a worker that loses a token-refresh race may fail one call before it re-reads
  the rotated tokens.
