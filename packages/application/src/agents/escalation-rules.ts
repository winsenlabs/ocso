import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { escalationRules, uuidv7, type Db } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import type { ActorContext } from '../shared/context.js';
import { assertAgentManageable, assertAgentReadable } from './access.js';

/** Deterministic trigger conditions evaluated in code (docs/01 §6); the prompt covers judgement calls. */
export const EscalationCondition = z.object({
  keywords: z.array(z.string().trim().min(2).max(80)).max(50).optional(),
  consecutiveToolFailures: z.number().int().min(1).max(10).optional(),
  customerRequestsHuman: z.boolean().optional(),
  amountAbove: z.number().positive().optional(),
});

export const EscalationRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(['CUSTOMER_REQUEST', 'AGENT_DECISION', 'POLICY', 'INTENT', 'RISK', 'TOOL_FAILURE', 'SLA', 'LOW_CONFIDENCE', 'BUSINESS_RULE', 'SENSITIVE_ACTION']),
  condition: EscalationCondition.default({}),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']).default('OPEN_PICKUP'),
  targetQueueId: z.uuid().nullable().default(null),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).default('P3'),
  enabled: z.boolean().default(true),
});
export type EscalationRuleInput = z.infer<typeof EscalationRuleInput>;
export const EscalationRulePatch = EscalationRuleInput.partial();
export type EscalationRulePatch = z.infer<typeof EscalationRulePatch>;
export type EscalationRuleRow = typeof escalationRules.$inferSelect;

/**
 * Escalation rules per agent (and platform-wide) — design/02 Escalation tab.
 * Agent rules are read with the agent (readable) and changed only by leads of
 * an owning team (ADR-026); a rule is addressed through its own agent, so a
 * rule id of another agent is not found. Platform-wide rules (agentId null)
 * are listed with every agent and are read-only through these routes.
 */
export class EscalationRuleService {
  constructor(private readonly db: Db) {}

  async list(principal: Principal, agentId: string): Promise<EscalationRuleRow[]> {
    await assertAgentReadable(this.db, principal, agentId);
    return this.db
      .select()
      .from(escalationRules)
      .where(or(eq(escalationRules.agentId, agentId), isNull(escalationRules.agentId)))
      .orderBy(asc(escalationRules.priority), asc(escalationRules.name));
  }

  private async canManage(actor: ActorContext, agentId: string): Promise<void> {
    assertCan(actor.principal!, Permission.ESCALATION_MANAGE);
    await assertAgentManageable(this.db, actor.principal!, agentId);
  }

  async create(actor: ActorContext, agentId: string, input: EscalationRuleInput): Promise<EscalationRuleRow> {
    await this.canManage(actor, agentId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(escalationRules).values({ id: uuidv7(), agentId, ...input }).returning();
      await recordAudit(tx, actor, { action: 'escalation_rule.create', targetType: 'escalation_rule', targetId: row!.id, summary: `Escalation rule "${input.name}"`, after: input });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'policy_changed');
      return row!;
    });
  }

  async update(actor: ActorContext, agentId: string, id: string, input: EscalationRulePatch): Promise<EscalationRuleRow> {
    await this.canManage(actor, agentId);
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(escalationRules).where(and(eq(escalationRules.id, id), eq(escalationRules.agentId, agentId)));
      if (!before) throw notFound('escalation_rule', id);
      const [row] = await tx.update(escalationRules).set({ ...input, updatedAt: new Date() }).where(eq(escalationRules.id, id)).returning();
      await recordAudit(tx, actor, { action: 'escalation_rule.update', targetType: 'escalation_rule', targetId: id, summary: `Updated "${before.name}"`, before, after: input });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'policy_changed');
      return row!;
    });
  }

  async remove(actor: ActorContext, agentId: string, id: string): Promise<void> {
    await this.canManage(actor, agentId);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.delete(escalationRules).where(and(eq(escalationRules.id, id), eq(escalationRules.agentId, agentId))).returning();
      if (!before) throw notFound('escalation_rule', id);
      await recordAudit(tx, actor, { action: 'escalation_rule.delete', targetType: 'escalation_rule', targetId: id, summary: `Deleted "${before.name}"`, before });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'policy_changed');
    });
  }

  /** Rules relevant to a runtime trigger for an agent (agent rules first, then global). */
  async match(agentId: string, trigger: EscalationRuleInput['trigger']): Promise<EscalationRuleRow[]> {
    const rows = await this.db
      .select()
      .from(escalationRules)
      .where(and(eq(escalationRules.trigger, trigger), eq(escalationRules.enabled, true), or(eq(escalationRules.agentId, agentId), isNull(escalationRules.agentId))));
    return rows.sort((a, b) => Number(b.agentId !== null) - Number(a.agentId !== null));
  }
}
