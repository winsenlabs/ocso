import { and, asc, eq, inArray, ne, or, isNull, sql } from 'drizzle-orm';
import { createDefaultDeliveryRegistry, type AlertKind, type DestinationEventRouting } from '@ocso/alerts';
import { Permission, can, type Principal } from '@ocso/auth';
import type { QueueAdapter } from '@ocso/queue';
import { alertRules, alerts, notificationDestinations, virtualAgents, type DbOrTx } from '@ocso/db';
import { describeDiff, diffFields, isDomainError, notFound, validation } from '@ocso/domain';
import { assertAgentReadable, owningTeams, readableAgentFilter } from '../agents/access.js';
import { loadPerson } from '../approvals/access.js';
import type { ApprovalDescriptor, ProposalRow } from '../approvals/contract.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { ALERT_READ_PERMISSION, RULE_MANAGE_PERMISSION } from './audience.js';
import { mergeAlertRule, validateAlertRule, type AlertRuleFields } from './alert-rule-validation.js';
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from './evaluators/registry.js';
import { publishDeliveries, type PendingDelivery } from './dispatch.js';
import { markResolved } from './lifecycle.js';
import { AlertRuleApprovalPatch } from './rule-inputs.js';
import type { AlertRuleRow } from './views.js';

/**
 * Alert rules as maker–checker objects (PM/research/11 §4): two kinds over one
 * table. `alert_rule` — business rules, made with alert_rules.business.manage
 * and checked with approvals.check.agents; `alert_rule_technical` — technical
 * rules, alert_rules.technical.manage and approvals.check.platform. A new rule
 * is a disabled draft; turning it on is ACTIVATE; changing an approved rule is
 * UPDATE; DELETE always needs a checker. Turning a rule off is a stop.
 */
export const ALERT_RULE_KINDS: Readonly<Record<AlertKind, string>> = { BUSINESS: 'alert_rule', TECHNICAL: 'alert_rule_technical' };

/** The approval kind of a rule of this alert kind. */
export const alertRuleObjectKind = (kind: AlertKind): string => ALERT_RULE_KINDS[kind];

export interface AlertRuleApprovalDeps {
  /** Which destination kinds receive the RESOLVED event when a deleted rule's alerts close (the worker passes its registry; default: built-in adapters). */
  alertRouting?: DestinationEventRouting | undefined;
  /** Publishes those deliveries at once (worker); without it the redispatch sweep sends them. */
  alertQueue?: QueueAdapter | undefined;
  alertEvaluators?: EvaluatorRegistry | undefined;
}

function fieldsOf(row: AlertRuleRow): AlertRuleFields {
  const { id: _id, createdBy: _by, createdAt: _c, updatedAt: _u, ...fields } = row;
  return fields;
}

/** Platform-wide rules, or rules of an agent the principal can read (the rule service's own scope). */
function agentWhere(principal: Principal) {
  const scoped = readableAgentFilter(principal, alertRules.agentId);
  return scoped ? or(isNull(alertRules.agentId), scoped)! : sql`true`;
}

export function alertRuleApproval(alertKind: AlertKind, deps: AlertRuleApprovalDeps = {}): ApprovalDescriptor {
  const kind = ALERT_RULE_KINDS[alertKind];
  const evaluators = deps.alertEvaluators ?? createDefaultEvaluatorRegistry();
  // Only `receives` is used: which kinds get the RESOLVED event. Delivery itself runs in the worker.
  const routing: DestinationEventRouting = deps.alertRouting ?? createDefaultDeliveryRegistry({ fetch: () => Promise.reject(new Error('no delivery here')) });

  async function ruleOf(tx: DbOrTx, id: string): Promise<AlertRuleRow | null> {
    const [row] = await tx.select().from(alertRules).where(and(eq(alertRules.id, id), eq(alertRules.kind, alertKind)));
    return row ?? null;
  }

  async function project(tx: DbOrTx, r: AlertRuleFields): Promise<Record<string, unknown>> {
    const [agent] = r.agentId ? await tx.select({ name: virtualAgents.name }).from(virtualAgents).where(eq(virtualAgents.id, r.agentId)) : [];
    const destinations = r.destinationIds.length
      ? (await tx.select({ name: notificationDestinations.name }).from(notificationDestinations).where(inArray(notificationDestinations.id, r.destinationIds)).orderBy(asc(notificationDestinations.name))).map((d) => d.name)
      : [];
    return {
      name: r.name,
      kind: r.kind,
      condition: evaluators.find(r.condition)?.label ?? r.condition,
      params: r.params,
      agent: r.agentId ? (agent?.name ?? `missing (${r.agentId.slice(0, 8)})`) : 'Platform-wide',
      window: `${r.windowSeconds}s`,
      severity: r.severity,
      audience: [...r.audienceRoles].sort(),
      destinations,
      dedupeWindow: `${r.dedupeWindowSeconds}s`,
      autoResolve: r.autoResolve,
      enabled: r.enabled,
    };
  }

  function after(rule: AlertRuleRow, p: ProposalRow): AlertRuleFields | null {
    if (p.action === 'DELETE') return null;
    if (p.action === 'ACTIVATE') return { ...fieldsOf(rule), enabled: true };
    return { ...mergeAlertRule(fieldsOf(rule), AlertRuleApprovalPatch.parse(p.payload) as Partial<AlertRuleFields>), enabled: rule.enabled };
  }

  async function remove(tx: DbOrTx, actor: ActorContext, rule: AlertRuleRow): Promise<PendingDelivery[]> {
    // Nothing stays open forever: the rule's alerts resolve and their destinations are told.
    const pending: PendingDelivery[] = [];
    const open = await tx.select().from(alerts).where(and(eq(alerts.ruleId, rule.id), ne(alerts.status, 'RESOLVED')));
    for (const alert of open) {
      pending.push(...await markResolved(tx, actor, alert, {
        now: new Date(),
        resolvedBy: actor.principal?.userId ?? null,
        resolution: 'Resolved: alert rule deleted',
        destinationIds: rule.destinationIds,
        routing,
        auditAction: 'alert.rule_deleted',
        auditSummary: `Resolved alert "${alert.title}" because its rule was deleted`,
      }));
    }
    await tx.delete(alertRules).where(eq(alertRules.id, rule.id));
    await recordAudit(tx, actor, { action: 'alert_rule.delete', targetType: 'alert_rule', targetId: rule.id, summary: `Deleted alert rule "${rule.name}" (approved)`, before: rule });
    await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: rule.id });
    return pending;
  }

  return {
    kind,
    label: alertKind === 'TECHNICAL' ? 'Technical alert rule' : 'Business alert rule',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => RULE_MANAGE_PERMISSION[alertKind],
    checkPermission: alertKind === 'TECHNICAL' ? Permission.APPROVALS_CHECK_PLATFORM : Permission.APPROVALS_CHECK_AGENTS,
    payload: AlertRuleApprovalPatch,

    async project(tx, id) {
      const rule = await ruleOf(tx, id);
      return rule ? project(tx, fieldsOf(rule)) : null;
    },
    async projectAfter(tx, p) {
      const rule = await ruleOf(tx, p.objectId);
      const next = rule ? after(rule, p) : null;
      return next ? project(tx, next) : null;
    },
    /** Ids and values, never names; never `enabled` — turning a rule off (a stop) must not void a proposal waiting on it. */
    async hashBasis(tx, id) {
      const rule = await ruleOf(tx, id);
      if (!rule) return null;
      const { enabled: _enabled, ...fields } = fieldsOf(rule);
      return { ...fields, audienceRoles: [...fields.audienceRoles].sort(), destinationIds: [...fields.destinationIds].sort() };
    },
    /**
     * A business rule about an agent belongs to the agent's teams; everything else is platform-wide. A change that
     * moves the rule to another agent belongs to both agents' teams, so the new owner sees (and may check) it.
     */
    async teamIds(tx, id, payload) {
      const rule = await ruleOf(tx, id);
      const moved = payload?.['agentId'];
      const agentIds = [rule?.agentId, typeof moved === 'string' ? moved : null].filter((a): a is string => !!a);
      if (!agentIds.length) return [];
      const teams = await owningTeams(tx, agentIds);
      return [...new Set(agentIds.flatMap((a) => (teams.get(a) ?? []).map((t) => t.id)))].sort();
    },
    dependencies: async () => [],
    async assertVisible(tx, principal, id) {
      const readable = can(principal, ALERT_READ_PERMISSION[alertKind]) || can(principal, RULE_MANAGE_PERMISSION[alertKind]);
      const [row] = readable ? await tx.select({ id: alertRules.id }).from(alertRules).where(and(eq(alertRules.id, id), eq(alertRules.kind, alertKind), agentWhere(principal))) : [];
      if (!row) throw notFound('alert_rule', id);
    },
    /** Proposing needs the kind's manage permission and, for a rule about an agent, that agent in the maker's read scope. */
    async assertMakeable(tx, principal, id) {
      const rule = await ruleOf(tx, id);
      if (!rule || !can(principal, RULE_MANAGE_PERMISSION[alertKind])) throw notFound('alert_rule', id);
      if (rule.agentId) await assertAgentReadable(tx, principal, rule.agentId);
    },
    async validate(tx, p) {
      const rule = await ruleOf(tx, p.objectId);
      if (!rule) return [{ code: 'object_missing', message: 'The alert rule no longer exists.' }];
      if (p.action === 'DELETE') return [];
      if (p.action === 'ACTIVATE' && rule.enabled) return [{ code: 'already_enabled', message: `"${rule.name}" is already on.` }];
      try {
        const next = after(rule, p)!;
        // Moving the rule to another agent is scoped like creating one there: the maker must be able to read that agent.
        let scope: Principal | null = null;
        if (next.agentId && next.agentId !== rule.agentId && p.makerId) {
          scope = await loadPerson(tx, p.makerId);
          if (!scope) return [{ code: 'maker_inactive', message: 'The person who proposed this change can no longer make it.' }];
        }
        await validateAlertRule(tx, evaluators, scope, next);
        return [];
      } catch (err) {
        if (isDomainError(err)) return [{ code: err.code, message: err.message }];
        throw err;
      }
    },
    async activate(tx, actor, p) {
      const rule = await ruleOf(tx, p.objectId);
      if (!rule) throw validation('object_missing', 'The alert rule no longer exists');
      // Deleting resolves the rule's open alerts and notifies their destinations: the worker does it, where the
      // delivery registry (plugin destination kinds included) and the queue live. The rule stops firing now.
      if (p.action === 'DELETE') {
        if (rule.enabled) {
          await tx.update(alertRules).set({ enabled: false, updatedAt: new Date() }).where(eq(alertRules.id, rule.id));
          await recordAudit(tx, actor, { action: 'alert_rule.disable', targetType: 'alert_rule', targetId: rule.id, summary: `Turned off alert rule "${rule.name}" (deletion approved)`, before: { enabled: true }, after: { enabled: false } });
          await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: rule.id });
        }
        return { kind: 'DEFERRED' };
      }
      const fields = await validateAlertRule(tx, evaluators, null, after(rule, p)!);
      await tx.update(alertRules).set({ ...fields, updatedAt: new Date() }).where(eq(alertRules.id, rule.id));
      await recordAudit(tx, actor, {
        action: p.action === 'ACTIVATE' ? 'alert_rule.enable' : 'alert_rule.update',
        targetType: 'alert_rule',
        targetId: rule.id,
        summary: `${p.action === 'ACTIVATE' ? 'Turned on' : 'Updated'} alert rule "${fields.name}" (approved)`,
        before: rule,
        after: p.action === 'ACTIVATE' ? { enabled: true } : p.payload,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: rule.id });
      return { kind: 'DONE' };
    },
    async activateDeferred(db, actor, p) {
      const pending = await db.transaction(async (tx) => {
        const rule = await ruleOf(tx, p.objectId);
        return rule ? remove(tx, actor, rule) : [];
      });
      // Unpublished deliveries stay PENDING and the worker's redispatch sweep sends them.
      if (deps.alertQueue && pending.length) await publishDeliveries(deps.alertQueue, pending);
    },
    /** An approved deletion whose rule is gone already (a crash after the removal committed) only needs its stamp. */
    async settled(db, p) {
      return p.action === 'DELETE' && !(await db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, p.objectId))).length;
    },
    async liveObjects(tx) {
      return (await tx.select({ id: alertRules.id }).from(alertRules).where(and(eq(alertRules.kind, alertKind), eq(alertRules.enabled, true)))).map((r) => r.id);
    },
    title(p, before) {
      const name = `"${String(before?.['name'] ?? 'alert rule')}"`;
      if (p.action === 'DELETE') return `Delete alert rule ${name}`;
      if (p.action === 'ACTIVATE') return `Turn on alert rule ${name}`;
      return `Change alert rule ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
    },
  };
}
