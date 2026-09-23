# Ask OCSO tools

Ask OCSO is the internal agent every signed-in user can open with ⌘J / Ctrl+J. It answers questions
about the deployment and can propose changes. It acts **as the user**: it only sees tools the user's
role allows, every call is re-authorized, and a write runs only after the user confirms it
([docs/12-INTERNAL-OCSO-AGENT.md](../12-INTERNAL-OCSO-AGENT.md), ADR-017).

Each tool is a thin adapter over an existing application service. Shipped tools, in
`packages/internal-agent/src/tools/`: attention summary, list conversations, conversation detail, agent
performance, set agent status, queue status, worker capacity, update worker settings, latency breakdown,
prompt-cache stats, MCP health, recent changes.

## The contract

`packages/internal-agent/src/contract.ts`, trimmed:

```ts
export type InternalRisk = 'READ' | 'LOW_WRITE' | 'HIGH_WRITE';

export interface InternalTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** Exactly one permission gates the tool. */
  permission: Permission;
  risk: InternalRisk;
  /** Human-readable description of a write for the confirmation card. */
  describe?: ((args: I) => string) | undefined;
  /** Current → proposed values for the confirmation card. Read-only; never writes. */
  preview?: ((ctx: ToolContext, args: I) => Promise<ActionPreview>) | undefined;
  run(ctx: ToolContext, args: I): Promise<ToolAnswer>;
}
```

`ToolContext` carries the database, the user's `Principal`, an `ActorContext` for audit, and the time.
`ToolAnswer` is JSON data for the model, plus optional links and a small table the drawer renders.

## How one is registered

Add it to `DEFAULT_TOOLS` in `packages/internal-agent/src/registry.ts`. The api builds the registry once
(`apps/api/src/modules/internal-agent/internal-agent.module.ts`). `InternalToolRegistry.register()`
exists for adding a tool to an instance.

## What the core does for you

- **Filtering.** `specs(principal)` offers the model only the tools whose permission the user holds.
  The model never learns that other tools exist.
- **Re-authorization and validation.** `resolve()` checks the permission again and parses the arguments
  with your zod schema on every call.
- **Confirmation.** A `HIGH_WRITE` tool, or a `LOW_WRITE` tool when the deployment setting asks for it,
  is not run. It is stored as a pending action with your `describe`/`preview` text, and runs only when the
  same user confirms it in the drawer, after a fresh permission check. It is audited as done by that user
  through the internal agent.
- **Denials.** An authorization failure is shown to the user as "not available for your role" and
  explained to the model, instead of failing the conversation.

## Rules for a tool

- Call application services; do not write SQL that bypasses their authorization and scoping. For
  example, `agent_performance` uses `AgentService.list(principal)`, so a Head or Lead sees only the agents
  their teams own.
- Return no secrets in `data`, `links` or `table`.
- Classify honestly: anything that changes state is at least `LOW_WRITE`.

## Tests to copy

`packages/internal-agent/test/internal-agent.int.test.ts` (tool filtering, confirmation, execution) and
`agent-scope.int.test.ts` (team scoping), both against PostgreSQL with the scripted model. The browser
flow is in `apps/web/e2e/internal-agent.spec.ts`.

## Limits today

- Tools are registered in code only.
- Ask OCSO needs a model profile chosen under **Settings → Ask OCSO**.
