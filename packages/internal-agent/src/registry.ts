import { can, type Principal } from '@ocso/auth';
import { forbidden, validation } from '@ocso/domain';
import type { AnyInternalTool } from './contract.js';
import { agentPerformance } from './tools/agents.js';
import { attentionSummary } from './tools/attention.js';
import { conversationDetail, listConversations } from './tools/conversations.js';
import { latencyBreakdown, mcpHealth, promptCacheStats } from './tools/telemetry.js';
import { queueStatus, recentChanges, workerCapacity } from './tools/system.js';

/**
 * The insight tools (PM/research/12 §3): cross-service reads that join the capability catalog as
 * `insight.<name>` (scripts/capabilities reads this list). The model reaches them through `execute_tool`.
 */
export const INSIGHT_TOOLS: readonly AnyInternalTool[] = [
  attentionSummary,
  listConversations,
  conversationDetail,
  agentPerformance,
  queueStatus,
  workerCapacity,
  latencyBreakdown,
  promptCacheStats,
  mcpHealth,
  recentChanges,
];

/** @deprecated The insight tools; kept under the earlier name. */
export const DEFAULT_TOOLS = INSIGHT_TOOLS;

/** Insight tools by name, with the permission re-checked and the input validated on every run. */
export class InternalToolRegistry {
  private readonly byName: Map<string, AnyInternalTool>;

  constructor(tools: readonly AnyInternalTool[] = INSIGHT_TOOLS) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  register(tool: AnyInternalTool): this {
    this.byName.set(tool.name, tool);
    return this;
  }

  available(principal: Principal): AnyInternalTool[] {
    return [...this.byName.values()].filter((t) => can(principal, t.permission));
  }

  /** Resolve + authorize + validate. Throws typed errors the loop reports to the model. */
  resolve(principal: Principal, name: string, rawArgs: unknown): { tool: AnyInternalTool; args: unknown } {
    const tool = this.byName.get(name);
    if (!tool) throw validation('unknown_tool', `Unknown tool ${name}`);
    if (!can(principal, tool.permission)) throw forbidden(tool.permission, 'your role does not allow this');
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw validation('invalid_tool_arguments', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return { tool, args: parsed.data };
  }
}
