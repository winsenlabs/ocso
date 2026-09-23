import { can, type Principal } from '@ocso/auth';
import { forbidden, validation } from '@ocso/domain';
import type { ToolSpec } from '@ocso/domain';
import { z } from 'zod';
import type { AnyInternalTool } from './contract.js';
import { agentPerformance, setAgentStatus } from './tools/agents.js';
import { attentionSummary } from './tools/attention.js';
import { conversationDetail, listConversations } from './tools/conversations.js';
import { latencyBreakdown, mcpHealth, promptCacheStats } from './tools/telemetry.js';
import { queueStatus, recentChanges, updateWorkerSettings, workerCapacity } from './tools/system.js';

export const DEFAULT_TOOLS: readonly AnyInternalTool[] = [
  attentionSummary,
  listConversations,
  conversationDetail,
  agentPerformance,
  setAgentStatus,
  queueStatus,
  workerCapacity,
  updateWorkerSettings,
  latencyBreakdown,
  promptCacheStats,
  mcpHealth,
  recentChanges,
];

/**
 * The tool catalogue for one user (docs/12 §3): tools whose permission the
 * user lacks are not offered to the model at all, and every execution is
 * re-authorized — the model can never reach a tool the user could not use.
 */
export class InternalToolRegistry {
  private readonly byName: Map<string, AnyInternalTool>;

  constructor(tools: readonly AnyInternalTool[] = DEFAULT_TOOLS) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  register(tool: AnyInternalTool): this {
    this.byName.set(tool.name, tool);
    return this;
  }

  available(principal: Principal): AnyInternalTool[] {
    return [...this.byName.values()].filter((t) => can(principal, t.permission));
  }

  specs(principal: Principal): ToolSpec[] {
    return this.available(principal).map((t) => ({
      name: t.name,
      description: `${t.description}${t.risk === 'HIGH_WRITE' ? ' [requires user confirmation]' : t.risk === 'LOW_WRITE' ? ' [write]' : ''}`,
      inputSchema: z.toJSONSchema(t.input, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>,
    }));
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
