import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { validation } from '@ocso/domain';
import { mcpConnections, tools, type DbOrTx } from '@ocso/db';
import type { ArgumentRule } from '@ocso/tools';
import { z } from 'zod';
import { ArgumentRuleInput } from './inputs.js';
import type { ToolRow } from './records.js';

/** One tool grant as stored and as proposed (defaults applied). */
export const GrantConfig = z.object({
  toolId: z.uuid(),
  enabled: z.boolean().default(true),
  alwaysConfirm: z.boolean().default(false),
  argumentRules: z.array(ArgumentRuleInput).max(20).default([]),
});
export type GrantConfig = { toolId: string; enabled: boolean; alwaysConfirm: boolean; argumentRules: ArgumentRule[] };

/** What an approved `agent_tool_grant` UPDATE applies: the widening part of a grant change, as upserts. */
export const AgentToolGrantAdditions = z.object({ grants: z.array(GrantConfig).min(1).max(500) }).strict();

/** Tools an agent may be granted: approved, live, on an approved SHARED connection that allows this agent. */
export function grantable(agentId: string): SQL {
  return and(
    eq(tools.approved, true),
    isNull(tools.removedAt),
    eq(mcpConnections.scope, 'SHARED'),
    isNull(mcpConnections.ownerUserId),
    isNotNull(mcpConnections.approvedAt),
    ne(mcpConnections.status, 'DISABLED'),
    sql`(${mcpConnections.allowedAgentIds} @> ARRAY['*']::text[] OR ${mcpConnections.allowedAgentIds} @> ARRAY[${agentId}]::text[])`,
  )!;
}

/** Rule paths must start at a declared argument when the tool's input schema declares properties. */
export function assertRulePaths(tool: ToolRow, rules: readonly { path: string }[]): void {
  const props = tool.inputSchema['properties'];
  if (!props || typeof props !== 'object') return;
  const unknown = rules.map((r) => r.path).filter((p) => !Object.hasOwn(props, p.split('.')[0]!));
  if (unknown.length) throw validation('unknown_argument_path', `Argument rules reference unknown arguments of ${tool.name}`, { toolId: tool.id, paths: unknown });
}

/** The grantable tools among these ids (keyed by id); refuses the call when one is not grantable or a rule path is unknown. */
export async function assertGrantable(tx: DbOrTx, agentId: string, grants: readonly GrantConfig[]): Promise<Map<string, ToolRow>> {
  const ids = grants.map((g) => g.toolId);
  const rows = ids.length ? await tx.select({ t: tools }).from(tools).innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId)).where(and(inArray(tools.id, ids), grantable(agentId))) : [];
  const byId = new Map(rows.map((r) => [r.t.id, r.t]));
  const refused = ids.filter((id) => !byId.has(id));
  if (refused.length) throw validation('tool_not_grantable', 'Some tools are not approved for this agent', { toolIds: refused });
  for (const g of grants) assertRulePaths(byId.get(g.toolId)!, g.argumentRules);
  return byId;
}

/** Key-order-free JSON (jsonb re-orders object keys, so stored rules and parsed input compare by value). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Only takes access away: the tool stays off or goes off, confirmation stays on
 * or goes on, and every argument rule it had is still there (rules only restrict:
 * confirm or deny). Anything else — a new tool, turning one on, dropping
 * confirmation, removing or loosening a rule — widens what the agent may do.
 */
export function onlyNarrows(before: GrantConfig, after: GrantConfig): boolean {
  if (after.enabled && !before.enabled) return false;
  if (before.alwaysConfirm && !after.alwaysConfirm) return false;
  return before.argumentRules.every((rule) => after.argumentRules.some((r) => same(r, rule)));
}

export interface GrantDelta {
  /** Tools whose grant goes away (a stop: immediate). */
  removed: string[];
  /** Existing grants changed only to take access away (immediate). */
  narrowed: GrantConfig[];
  /** New grants and changes that widen access: through approval once the agent's configuration is approved. */
  widened: GrantConfig[];
}

/**
 * Split a replace-all grant set against what the agent has now (PM/research/11b:
 * "AgentToolGrantService.replace computes the delta, commits the removals
 * immediately … and, if there are additions, opens an UPDATE proposal carrying
 * only the additions").
 */
export function grantDelta(before: readonly GrantConfig[], next: readonly GrantConfig[]): GrantDelta {
  const now = new Map(before.map((g) => [g.toolId, g]));
  const wanted = new Set(next.map((g) => g.toolId));
  const delta: GrantDelta = { removed: before.filter((g) => !wanted.has(g.toolId)).map((g) => g.toolId), narrowed: [], widened: [] };
  for (const g of next) {
    const old = now.get(g.toolId);
    if (old && same(old, g)) continue;
    if (old && onlyNarrows(old, g)) delta.narrowed.push(g);
    else delta.widened.push(g);
  }
  return delta;
}

/** Stored grants in the comparable shape (sorted by tool). */
export function grantConfigs(rows: ReadonlyArray<{ toolId: string; enabled: boolean; alwaysConfirm: boolean; argumentRules: ArgumentRule[] }>): GrantConfig[] {
  return rows
    .map(({ toolId, enabled, alwaysConfirm, argumentRules }) => ({ toolId, enabled, alwaysConfirm, argumentRules }))
    .sort((a, b) => a.toolId.localeCompare(b.toolId));
}
