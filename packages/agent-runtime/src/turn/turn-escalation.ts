import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { escalationRules, interactionParts, type Db } from '@ocso/db';
import type { LoopResult } from './agent-loop.js';
import { proactiveRule, ruleForHandoff, type ActiveEscalationRule, type RuleMatch } from './escalation-rules.js';
import type { TurnHandoff } from './persist.js';

/** A turn's escalation rules, what the customer wrote, and a rule that matched before the model ran. */
export interface TurnEscalation {
  rules: readonly ActiveEscalationRule[];
  customerText: string;
  early: RuleMatch | null;
}

/**
 * Escalation rules (docs/concepts/virtual-agents.md#escalation-rules): a matching rule routes the turn's hand-off
 * by its queue, mode and priority, and a rule whose conditions fire hands off when the agent did not.
 */
export function withRule(intent: TurnHandoff | null, result: LoopResult, escalation: TurnEscalation): TurnHandoff | null {
  const signals = { customerText: escalation.customerText, consecutiveToolFailures: result.consecutiveToolFailures, customerAskedForHuman: Boolean(result.handoff?.customerAskedForHuman) };
  if (intent) {
    const match = ruleForHandoff(escalation.rules, intent.trigger, signals);
    return match ? { ...intent, ruleId: match.rule.id } : intent;
  }
  const match = escalation.early ?? proactiveRule(escalation.rules, signals);
  if (!match) return null;
  const wrote = escalation.customerText.trim().replace(/\s+/g, ' ');
  return {
    reason: match.reason,
    summary: `Escalation ${match.reason}.${wrote ? ` The customer wrote: “${wrote.length > 300 ? `${wrote.slice(0, 299)}…` : wrote}”` : ''}`,
    trigger: match.rule.trigger,
    ruleId: match.rule.id,
    byRule: true,
  };
}

/** Loads a turn's rules and checks the ones on what the customer wrote, before the model runs. */
export async function turnEscalation(db: Db, agentId: string, interactionIds: string[]): Promise<TurnEscalation> {
  const rules = await activeRules(db, agentId);
  if (!rules.length) return { rules, customerText: '', early: null };
  const customerText = await pendingCustomerText(db, interactionIds);
  return { rules, customerText, early: proactiveRule(rules, { customerText, consecutiveToolFailures: 0, customerAskedForHuman: false }) };
}

/** Enabled rules that apply to the agent: its own first, then platform-wide ones, oldest first. */
async function activeRules(db: Db, agentId: string): Promise<ActiveEscalationRule[]> {
  const rows = await db
    .select()
    .from(escalationRules)
    .where(and(eq(escalationRules.enabled, true), or(eq(escalationRules.agentId, agentId), isNull(escalationRules.agentId))))
    .orderBy(sql`${escalationRules.agentId} IS NULL`, asc(escalationRules.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, trigger: r.trigger as ActiveEscalationRule['trigger'], condition: r.condition as ActiveEscalationRule['condition'], priority: r.priority }));
}

/** The text of the customer messages a turn answers. */
async function pendingCustomerText(db: Db, interactionIds: string[]): Promise<string> {
  const parts = await db
    .select({ content: interactionParts.content })
    .from(interactionParts)
    .where(and(inArray(interactionParts.interactionId, interactionIds), eq(interactionParts.type, 'TEXT')));
  return parts.map((p) => (typeof p.content['text'] === 'string' ? p.content['text'] : '')).join('\n');
}
