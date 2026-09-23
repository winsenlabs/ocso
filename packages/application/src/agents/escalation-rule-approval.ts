import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { describeDiff, diffFields, forbidden, notFound, validation } from '@ocso/domain';
import { escalationRules, queueTeams, queues, virtualAgents, type DbOrTx } from '@ocso/db';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { lockObject } from '../approvals/guard.js';
import { dependencyOf } from '../approvals/hashing.js';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import type { ActorContext } from '../shared/context.js';
import { assertAgentManageable, assertAgentReadable, owningTeams } from './access.js';
import { lockAgentConfig } from './approval-lock.js';
import { EscalationRuleApprovalPatch, type EscalationRuleRow } from './escalation-rule-inputs.js';

/**
 * `escalation_rule` (PM/research/11 §4), checked with approvals.check.agents.
 * A rule is created as a disabled draft and edited freely until its first
 * approval. Turning it on (and back on after a disable) is ACTIVATE; any change
 * to an approved rule is UPDATE; DELETE always needs a checker. Turning a rule
 * off is a stop action: immediate, never a proposal, never locked.
 */
export const ESCALATION_RULE_KIND = 'escalation_rule';

async function ruleOf(tx: DbOrTx, id: string): Promise<EscalationRuleRow | null> {
  const [row] = await tx.select().from(escalationRules).where(eq(escalationRules.id, id));
  return row ?? null;
}

async function nameOf(tx: DbOrTx, table: typeof queues | typeof virtualAgents, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await tx.select({ name: table.name }).from(table).where(eq(table.id, id));
  return row?.name ?? `missing (${id.slice(0, 8)})`;
}

type RuleFields = Pick<EscalationRuleRow, 'agentId' | 'name' | 'trigger' | 'condition' | 'mode' | 'targetQueueId' | 'priority' | 'enabled'>;

async function project(tx: DbOrTx, r: RuleFields): Promise<Record<string, unknown>> {
  return {
    agent: r.agentId ? await nameOf(tx, virtualAgents, r.agentId) : 'Every agent (platform-wide)',
    name: r.name,
    trigger: r.trigger,
    condition: r.condition,
    mode: r.mode,
    targetQueue: await nameOf(tx, queues, r.targetQueueId),
    priority: r.priority,
    enabled: r.enabled,
  };
}

function after(rule: EscalationRuleRow, p: ProposalRow): RuleFields | null {
  if (p.action === 'DELETE') return null;
  if (p.action === 'ACTIVATE') return { ...rule, enabled: true };
  const patch = EscalationRuleApprovalPatch.parse(p.payload);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<RuleFields>;
  return { ...rule, ...defined, enabled: rule.enabled };
}

/** Apply an approved escalation-rule proposal (and the rule's own audit row + the agent's cache bump). */
async function apply(tx: DbOrTx, actor: ActorContext, rule: EscalationRuleRow, p: ProposalRow): Promise<void> {
  const target = { targetType: ESCALATION_RULE_KIND, targetId: rule.id };
  if (p.action === 'DELETE') {
    await tx.delete(escalationRules).where(eq(escalationRules.id, rule.id));
    await recordAudit(tx, actor, { action: 'escalation_rule.delete', ...target, summary: `Deleted "${rule.name}" (approved)`, before: rule });
  } else if (p.action === 'ACTIVATE') {
    await tx.update(escalationRules).set({ enabled: true, updatedAt: new Date() }).where(eq(escalationRules.id, rule.id));
    await recordAudit(tx, actor, { action: 'escalation_rule.enable', ...target, summary: `Turned on "${rule.name}" (approved)`, before: { enabled: false }, after: { enabled: true } });
  } else {
    const patch = EscalationRuleApprovalPatch.parse(p.payload);
    await tx.update(escalationRules).set({ ...patch, updatedAt: new Date() }).where(eq(escalationRules.id, rule.id));
    await recordAudit(tx, actor, { action: 'escalation_rule.update', ...target, summary: `Updated "${rule.name}" (approved)`, before: rule, after: patch });
  }
  if (rule.agentId) await bumpGeneration(tx, actor.correlationId, `agent:${rule.agentId}`, 'policy_changed');
}

export const escalationRuleApproval: ApprovalDescriptor = {
  kind: ESCALATION_RULE_KIND,
  label: 'Escalation rule',
  actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
  makePermission: () => Permission.ESCALATION_MANAGE,
  checkPermission: Permission.APPROVALS_CHECK_AGENTS,
  payload: EscalationRuleApprovalPatch,

  async project(tx, id) {
    const rule = await ruleOf(tx, id);
    return rule ? project(tx, rule) : null;
  },
  async projectAfter(tx, p) {
    const rule = await ruleOf(tx, p.objectId);
    const next = rule ? after(rule, p) : null;
    return next ? project(tx, next) : null;
  },
  /** Identifiers, never names; never `enabled` — turning a rule off (a stop) must not void a proposal waiting on it. */
  async hashBasis(tx, id) {
    const r = await ruleOf(tx, id);
    return r ? { agentId: r.agentId, name: r.name, trigger: r.trigger, condition: r.condition, mode: r.mode, targetQueueId: r.targetQueueId, priority: r.priority } : null;
  },
  /** An agent's rule takes the agent's configuration lock: its writes serialize with every write to the agent. */
  async lock(tx, id) {
    const rule = await ruleOf(tx, id);
    if (rule?.agentId) await lockAgentConfig(tx, rule.agentId);
    else await lockObject(tx, `${ESCALATION_RULE_KIND}:${id}`);
  },
  /** The agent's own proposal shows its rules to the checker (a go-live): while it is open, its rules wait. */
  async related(tx, id) {
    const rule = await ruleOf(tx, id);
    return rule?.agentId ? [{ kind: 'agent', objectIds: [rule.agentId] }] : [];
  },
  /**
   * The agent's owning teams, plus the teams serving the queue its escalations go to (now, and after the change):
   * the people who will receive those conversations see — and may check — the rule that sends them.
   */
  async teamIds(tx, id, payload) {
    const rule = await ruleOf(tx, id);
    if (!rule?.agentId) return [];
    const agentTeams = ((await owningTeams(tx, [rule.agentId])).get(rule.agentId) ?? []).map((t) => t.id);
    const moved = payload?.['targetQueueId'];
    const queueIds = [rule.targetQueueId, typeof moved === 'string' ? moved : null].filter((q): q is string => !!q);
    const served = queueIds.length ? (await tx.select({ teamId: queueTeams.teamId }).from(queueTeams).where(inArray(queueTeams.queueId, queueIds))).map((r) => r.teamId) : [];
    return [...new Set([...agentTeams, ...served])].sort();
  },
  async dependencies(tx, p) {
    const rule = await ruleOf(tx, p.objectId);
    const next = rule ? after(rule, p) : null;
    if (!next?.targetQueueId) return [];
    const [q] = await tx.select({ updatedAt: queues.updatedAt }).from(queues).where(eq(queues.id, next.targetQueueId));
    return [dependencyOf('queue', next.targetQueueId, q?.updatedAt)];
  },
  async assertVisible(tx, principal, id) {
    const rule = await ruleOf(tx, id);
    if (!rule) throw notFound(ESCALATION_RULE_KIND, id);
    if (rule.agentId) await assertAgentReadable(tx, principal, rule.agentId);
    else assertCan(principal, Permission.AGENTS_READ);
  },
  /** Proposing is a write: a Lead of one of the agent's owning teams. Platform-wide rules are not changed from OCSO. */
  async assertMakeable(tx, principal, id) {
    const rule = await ruleOf(tx, id);
    if (!rule) throw notFound(ESCALATION_RULE_KIND, id);
    if (!rule.agentId) throw forbidden(Permission.ESCALATION_MANAGE, 'platform-wide escalation rules are read-only here');
    await assertAgentManageable(tx, principal, rule.agentId);
  },
  async validate(tx, p) {
    const rule = await ruleOf(tx, p.objectId);
    if (!rule) return [{ code: 'object_missing', message: 'The escalation rule no longer exists.' }];
    const problems: ApprovalProblem[] = [];
    if (p.action === 'ACTIVATE' && rule.enabled) problems.push({ code: 'already_enabled', message: `"${rule.name}" is already on.` });
    const next = after(rule, p);
    if (next?.targetQueueId) {
      const [q] = await tx.select({ id: queues.id }).from(queues).where(eq(queues.id, next.targetQueueId));
      if (!q) problems.push({ code: 'queue_missing', message: 'The target queue no longer exists.' });
    }
    return problems;
  },
  async activate(tx, actor, p) {
    const rule = await ruleOf(tx, p.objectId);
    if (!rule) throw validation('object_missing', 'The escalation rule no longer exists');
    await apply(tx, actor, rule, p);
    return { kind: 'DONE' };
  },
  /** Enabled agent rules. Platform-wide rules (agentId null) are not OCSO's to change (assertMakeable), so not reported here. */
  async liveObjects(tx) {
    return (await tx.select({ id: escalationRules.id }).from(escalationRules).where(and(eq(escalationRules.enabled, true), isNotNull(escalationRules.agentId)))).map((r) => r.id);
  },
  title(p, before) {
    const name = `"${String(before?.['name'] ?? 'rule')}"`;
    const agent = String(before?.['agent'] ?? 'the agent');
    if (p.action === 'DELETE') return `Delete escalation rule ${name} of ${agent}`;
    if (p.action === 'ACTIVATE') return `Turn on escalation rule ${name} for ${agent}`;
    return `Change escalation rule ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};
