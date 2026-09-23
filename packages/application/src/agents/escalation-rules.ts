import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { notFound, validation } from '@ocso/domain';
import { escalationRules, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { assertChangeAllowed, isApproved } from '../approvals/guard.js';
import { approvalStates, type ListedApprovalState } from '../approvals/object-states.js';
import { discardUnsubmittedDraft } from '../approvals/unsubmitted-draft.js';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import type { ActorContext } from '../shared/context.js';
import { assertAgentManageable, assertAgentReadable } from './access.js';
import { assertAgentUnlocked, lockAgentConfig } from './approval-lock.js';
import { ESCALATION_RULE_KIND, escalationRuleApproval } from './escalation-rule-approval.js';
import { EscalationRuleInput, type EscalationRulePatch, type EscalationRuleRow } from './escalation-rule-inputs.js';

export * from './escalation-rule-inputs.js';
export { ESCALATION_RULE_KIND, escalationRuleApproval } from './escalation-rule-approval.js';

/** A rule with its maker–checker state (the Escalation tab shows "Pending approval" and whether it was ever approved). */
export type EscalationRuleView = EscalationRuleRow & { approval: ListedApprovalState };

/**
 * What a PUT on a rule means (PM/research/11 §4): turning it off is a stop
 * (immediate); turning it on is ACTIVATE (always a proposal); any other change
 * is applied to a draft directly, and is an UPDATE proposal once the rule has
 * been approved. `enabled` goes alone.
 */
export type EscalationRuleChange = { kind: 'disable' } | { kind: 'activate' } | { kind: 'update'; patch: Omit<EscalationRulePatch, 'enabled'> } | { kind: 'none' };

/**
 * Escalation rules per agent (and platform-wide) — design/02 Escalation tab.
 * Agent rules are read with the agent (readable) and changed only by leads of
 * an owning team (ADR-026); a rule is addressed through its own agent, so a
 * rule id of another agent is not found. Platform-wide rules (agentId null)
 * are listed with every agent and are read-only through these routes. A new
 * rule is a disabled draft; turning it on needs a checker (escalation-rule-approval.ts).
 */
export class EscalationRuleService {
  constructor(private readonly db: Db) {}

  async list(principal: Principal, agentId: string): Promise<EscalationRuleView[]> {
    await assertAgentReadable(this.db, principal, agentId);
    const rows = await this.db
      .select()
      .from(escalationRules)
      .where(or(eq(escalationRules.agentId, agentId), isNull(escalationRules.agentId)))
      .orderBy(asc(escalationRules.priority), asc(escalationRules.name));
    const states = await approvalStates(this.db, ESCALATION_RULE_KIND, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, approval: states.get(r.id)! }));
  }

  private async canManage(actor: ActorContext, agentId: string): Promise<void> {
    assertCan(actor.principal!, Permission.ESCALATION_MANAGE);
    await assertAgentManageable(this.db, actor.principal!, agentId);
  }

  /** 404 unless the rule belongs to this agent and the caller manages the agent. */
  async assertRuleOf(actor: ActorContext, agentId: string, id: string): Promise<EscalationRuleRow> {
    await this.canManage(actor, agentId);
    const [rule] = await this.db.select().from(escalationRules).where(and(eq(escalationRules.id, id), eq(escalationRules.agentId, agentId)));
    if (!rule) throw notFound(ESCALATION_RULE_KIND, id);
    return rule;
  }

  /** A new rule is always a disabled draft: inert until an approved ACTIVATE turns it on. */
  async create(actor: ActorContext, agentId: string, raw: EscalationRuleInput): Promise<EscalationRuleRow> {
    await this.canManage(actor, agentId);
    const { enabled: _ignored, ...input } = EscalationRuleInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await lockAgentUnlocked(tx, agentId);
      const [row] = await tx.insert(escalationRules).values({ id: uuidv7(), agentId, ...input, enabled: false }).returning();
      await recordAudit(tx, actor, { action: 'escalation_rule.create', targetType: ESCALATION_RULE_KIND, targetId: row!.id, summary: `Escalation rule "${input.name}" (draft, off until approved)`, after: { ...input, enabled: false } });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'policy_changed');
      return row!;
    });
  }

  /** Classify a PUT (see EscalationRuleChange). */
  async plan(actor: ActorContext, agentId: string, id: string, patch: EscalationRulePatch): Promise<EscalationRuleChange> {
    const rule = await this.assertRuleOf(actor, agentId, id);
    const { enabled, ...fields } = patch;
    const changed = Object.entries(fields).some(([, v]) => v !== undefined);
    const toggles = enabled !== undefined && enabled !== rule.enabled;
    if (toggles && changed) throw validation('enabled_alone', 'Turn a rule on or off on its own, then change it');
    if (toggles) return { kind: enabled ? 'activate' : 'disable' };
    return changed ? { kind: 'update', patch: fields } : { kind: 'none' };
  }

  /** A draft's change, applied directly (409 approval_required once the rule has been approved; approval_open while one waits). */
  async update(actor: ActorContext, agentId: string, id: string, patch: Omit<EscalationRulePatch, 'enabled'>): Promise<EscalationRuleRow> {
    await this.assertRuleOf(actor, agentId, id);
    return this.db.transaction(async (tx) => {
      await lockAgentUnlocked(tx, agentId);
      await assertChangeAllowed(tx, escalationRuleApproval, id, 'UPDATE');
      const [before] = await tx.select().from(escalationRules).where(eq(escalationRules.id, id));
      const [row] = await tx.update(escalationRules).set({ ...patch, updatedAt: new Date() }).where(eq(escalationRules.id, id)).returning();
      await recordAudit(tx, actor, { action: 'escalation_rule.update', targetType: ESCALATION_RULE_KIND, targetId: id, summary: `Updated "${before!.name}"`, before, after: patch });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'policy_changed');
      return row!;
    });
  }

  /** Turning a rule off is a stop: immediate, never a proposal, and never refused because a proposal is open. */
  async disable(actor: ActorContext, agentId: string, id: string): Promise<EscalationRuleRow> {
    await this.assertRuleOf(actor, agentId, id);
    return this.db.transaction(async (tx) => {
      await lockAgentConfig(tx, agentId);
      const [before] = await tx.select().from(escalationRules).where(eq(escalationRules.id, id)).for('update');
      if (!before?.enabled) return before!; // already off: nothing changes, nothing to audit
      const [row] = await tx.update(escalationRules).set({ enabled: false, updatedAt: new Date() }).where(eq(escalationRules.id, id)).returning();
      await recordAudit(tx, actor, { action: 'escalation_rule.disable', targetType: ESCALATION_RULE_KIND, targetId: id, summary: `Turned off "${row!.name}"`, before: { enabled: true }, after: { enabled: false } });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'policy_changed');
      return row!;
    });
  }

  /** Undo a rule this request created when its ACTIVATE could not be submitted (never once anything was proposed). */
  async discardFailedCreate(actor: ActorContext, rule: EscalationRuleRow): Promise<void> {
    await discardUnsubmittedDraft(this.db, actor, {
      kind: ESCALATION_RULE_KIND,
      id: rule.id,
      name: `"${rule.name}"`,
      remove: async (tx) => void (await tx.delete(escalationRules).where(and(eq(escalationRules.id, rule.id), eq(escalationRules.enabled, false)))),
    });
  }

  /** Whether the rule has been approved (then every change is a proposal). */
  approved(id: string): Promise<boolean> {
    return isApproved(this.db, ESCALATION_RULE_KIND, id);
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

/** The agent's escalation rules are part of what an open agent proposal shows its checker (11b): drafts wait while one is open. */
async function lockAgentUnlocked(tx: DbOrTx, agentId: string): Promise<void> {
  await lockAgentConfig(tx, agentId);
  await assertAgentUnlocked(tx, agentId);
}
