import { and, eq } from 'drizzle-orm';
import { viaInternalAgent, type Principal } from '@ocso/auth';
import { recordAudit } from '@ocso/application';
import { DomainError, forbidden, notFound } from '@ocso/domain';
import { internalAgentActions, uuidv7, type Db } from '@ocso/db';
import type { AnyInternalTool, ToolAnswer } from './contract.js';
import type { InternalToolRegistry } from './registry.js';

const ACTION_TTL_MS = 15 * 60_000;

export interface PendingAction {
  id: string;
  tool: string;
  risk: string;
  description: string;
  expiresAt: string;
}

/**
 * Confirmation-gated writes (docs/12 §4): the model can only *propose* them;
 * execution happens when the same user confirms in the UI, after a fresh
 * permission check. Attributed to the human, audited as via=INTERNAL_AGENT.
 */
export class InternalActionService {
  constructor(
    private readonly db: Db,
    private readonly registry: InternalToolRegistry,
  ) {}

  async propose(principal: Principal, threadId: string, tool: AnyInternalTool, args: unknown): Promise<PendingAction> {
    const id = uuidv7();
    const description = tool.describe?.(args) ?? `${tool.name} ${JSON.stringify(args)}`;
    const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
    await this.db.insert(internalAgentActions).values({
      id,
      threadId,
      userId: principal.userId,
      tool: tool.name,
      params: args as Record<string, unknown>,
      risk: tool.risk,
      description,
      expiresAt,
    });
    return { id, tool: tool.name, risk: tool.risk, description, expiresAt: expiresAt.toISOString() };
  }

  async confirm(principal: Principal, actionId: string, correlationId: string): Promise<ToolAnswer> {
    const action = await this.load(principal, actionId);
    const { tool, args } = this.registry.resolve(principal, action.tool, action.params);
    const actor = { principal: viaInternalAgent(principal), correlationId };
    try {
      const answer = await tool.run({ db: this.db, principal: actor.principal, actor, now: new Date() }, args);
      await this.db.transaction(async (tx) => {
        await tx.update(internalAgentActions).set({ status: 'EXECUTED', result: answer.data as Record<string, unknown>, decidedAt: new Date() }).where(eq(internalAgentActions.id, actionId));
        await recordAudit(tx, actor, {
          action: 'internal_agent.action_confirmed',
          targetType: 'internal_agent_action',
          targetId: actionId,
          summary: `Confirmed: ${action.description}`,
          confirmation: { confirmedBy: principal.userId, tool: action.tool, risk: action.risk },
          after: action.params,
        });
      });
      return answer;
    } catch (err) {
      await this.db.update(internalAgentActions).set({ status: 'FAILED', result: { error: (err as Error).message }, decidedAt: new Date() }).where(eq(internalAgentActions.id, actionId));
      throw err;
    }
  }

  async reject(principal: Principal, actionId: string, correlationId: string): Promise<void> {
    const action = await this.load(principal, actionId);
    await this.db.transaction(async (tx) => {
      await tx.update(internalAgentActions).set({ status: 'REJECTED', decidedAt: new Date() }).where(eq(internalAgentActions.id, actionId));
      await recordAudit(tx, { principal: viaInternalAgent(principal), correlationId }, {
        action: 'internal_agent.action_rejected',
        targetType: 'internal_agent_action',
        targetId: actionId,
        summary: `Rejected: ${action.description}`,
      });
    });
  }

  private async load(principal: Principal, actionId: string) {
    const [action] = await this.db.select().from(internalAgentActions).where(and(eq(internalAgentActions.id, actionId), eq(internalAgentActions.userId, principal.userId)));
    if (!action) throw notFound('internal_agent_action', actionId);
    if (action.status !== 'PENDING') throw new DomainError('conflict', 'action_not_pending', `Action is already ${action.status.toLowerCase()}`);
    if (action.expiresAt < new Date()) {
      await this.db.update(internalAgentActions).set({ status: 'EXPIRED' }).where(eq(internalAgentActions.id, actionId));
      throw forbidden('internal_agent_action', 'confirmation window expired');
    }
    return action;
  }
}
