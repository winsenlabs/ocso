import { and, asc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type { AlertKind } from '@ocso/alerts';
import type { Role } from '@ocso/auth';
import { alertRules, alerts, notificationDestinations, uuidv7, virtualAgents, type Db, type DbOrTx } from '@ocso/db';
import { forbidden, notFound, validation } from '@ocso/domain';
import type { QueueAdapter } from '@ocso/queue';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertCanManageKind, manageableKinds, readableKinds, requirePrincipal, roleCanReadKind } from './audience.js';
import { publishDeliveries, type PendingDelivery } from './dispatch.js';
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from './evaluators/registry.js';
import { markResolved } from './lifecycle.js';
import type { AlertRuleInput, AlertRuleListQuery, AlertRulePatch } from './rule-inputs.js';
import { toRuleView, type AlertRuleRow, type AlertRuleView } from './views.js';

export interface AlertConditionView {
  condition: string;
  label: string;
  kinds: readonly AlertKind[];
  agentScoped: boolean;
  method: string;
  params: Record<string, unknown>;
}

type RuleFields = Omit<AlertRuleRow, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'>;

/**
 * Alert rule CRUD (PM/BUILD-PLAN E8.8). TECHNICAL rules need
 * alert_rules.technical.manage, BUSINESS rules alert_rules.business.manage.
 */
export class AlertRuleService {
  private readonly evaluators: EvaluatorRegistry;

  constructor(
    private readonly db: Db,
    private readonly queue: QueueAdapter,
    evaluators?: EvaluatorRegistry,
  ) {
    this.evaluators = evaluators ?? createDefaultEvaluatorRegistry();
  }

  /** Evaluator catalogue (method + params JSON schema) for kinds the user may see. */
  conditions(actor: ActorContext): AlertConditionView[] {
    const visible = this.visibleKinds(actor);
    return this.evaluators
      .list()
      .filter((e) => e.kinds.some((k) => visible.includes(k)))
      .map((e) => ({ condition: e.condition, label: e.label, kinds: e.kinds, agentScoped: e.agentScoped, method: e.method, params: e.paramsJsonSchema() }));
  }

  async list(actor: ActorContext, query: AlertRuleListQuery = {}): Promise<AlertRuleView[]> {
    const visible = this.visibleKinds(actor);
    if (query.kind && !visible.includes(query.kind)) throw forbidden('alert_rules.read', `cannot read ${query.kind.toLowerCase()} alert rules`);
    const kinds = query.kind ? [query.kind] : visible;
    if (!kinds.length) return [];
    const where: SQL[] = [inArray(alertRules.kind, kinds)];
    if (query.agentId) where.push(eq(alertRules.agentId, query.agentId));
    const rows = await this.db.select().from(alertRules).where(and(...where)).orderBy(asc(alertRules.kind), asc(alertRules.name));
    return rows.map((r) => this.view(r));
  }

  async get(actor: ActorContext, id: string): Promise<AlertRuleView> {
    const row = await this.load(this.db, id);
    if (!this.visibleKinds(actor).includes(row.kind)) throw notFound('alert_rule', id);
    return this.view(row);
  }

  async create(actor: ActorContext, input: AlertRuleInput): Promise<AlertRuleView> {
    const principal = assertCanManageKind(actor, input.kind);
    const id = uuidv7();
    const row = await this.db.transaction(async (tx) => {
      const fields = await this.validate(tx, input);
      const [inserted] = await tx
        .insert(alertRules)
        .values({ id, ...fields, createdBy: principal.userId })
        .returning();
      await recordAudit(tx, actor, {
        action: 'alert_rule.create',
        targetType: 'alert_rule',
        targetId: id,
        summary: `Created ${input.kind.toLowerCase()} alert rule "${input.name}" (${input.condition})`,
        after: fields,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: id });
      return inserted!;
    });
    return this.view(row);
  }

  async update(actor: ActorContext, id: string, patch: AlertRulePatch): Promise<AlertRuleView> {
    const row = await this.db.transaction(async (tx) => {
      const before = await this.load(tx, id);
      assertCanManageKind(actor, before.kind);
      if (patch.kind && patch.kind !== before.kind) assertCanManageKind(actor, patch.kind);
      const merged: RuleFields = { ...before, ...(stripUndefined(patch) as Partial<RuleFields>) };
      // A condition change resets params unless new ones are supplied.
      if (patch.condition && patch.condition !== before.condition && patch.params === undefined) merged.params = {};
      const fields = await this.validate(tx, merged);
      const [updated] = await tx
        .update(alertRules)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(alertRules.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'alert_rule.update',
        targetType: 'alert_rule',
        targetId: id,
        summary: `Updated alert rule "${updated!.name}"`,
        before,
        after: patch,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: id });
      return updated!;
    });
    return this.view(row);
  }

  /** Deletes the rule and resolves its unresolved alerts (so nothing stays open forever). */
  async delete(actor: ActorContext, id: string): Promise<void> {
    const pending: PendingDelivery[] = [];
    await this.db.transaction(async (tx) => {
      const rule = await this.load(tx, id);
      const principal = assertCanManageKind(actor, rule.kind);
      const open = await tx.select().from(alerts).where(and(eq(alerts.ruleId, id), ne(alerts.status, 'RESOLVED')));
      for (const alert of open) {
        pending.push(
          ...(await markResolved(tx, actor, alert, {
            now: new Date(),
            resolvedBy: principal.userId,
            resolution: 'Resolved: alert rule deleted',
            destinationIds: rule.destinationIds,
            auditAction: 'alert.rule_deleted',
            auditSummary: `Resolved alert "${alert.title}" because its rule was deleted`,
          })),
        );
      }
      await tx.delete(alertRules).where(eq(alertRules.id, id));
      await recordAudit(tx, actor, {
        action: 'alert_rule.delete',
        targetType: 'alert_rule',
        targetId: id,
        summary: `Deleted alert rule "${rule.name}"`,
        before: rule,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: id });
    });
    await publishDeliveries(this.queue, pending);
  }

  private visibleKinds(actor: ActorContext): AlertKind[] {
    const principal = requirePrincipal(actor, 'alert_rules.read');
    return [...new Set([...readableKinds(principal), ...manageableKinds(principal)])];
  }

  private async load(db: DbOrTx, id: string): Promise<AlertRuleRow> {
    const [row] = await db.select().from(alertRules).where(eq(alertRules.id, id));
    if (!row) throw notFound('alert_rule', id);
    return row;
  }

  private view(row: AlertRuleRow): AlertRuleView {
    return toRuleView(row, this.evaluators.find(row.condition)?.label ?? null);
  }

  /** Validate a complete rule and return normalized, storable fields. */
  private async validate(db: DbOrTx, input: RuleFields): Promise<RuleFields> {
    const evaluator = this.evaluators.find(input.condition);
    if (!evaluator) throw validation('unknown_condition', `Unknown alert condition "${input.condition}"`);
    if (!evaluator.kinds.includes(input.kind)) {
      throw validation('condition_kind_mismatch', `${input.condition} is a ${evaluator.kinds.join('/').toLowerCase()} condition`);
    }
    if (input.agentId && !evaluator.agentScoped) throw validation('condition_not_agent_scoped', `${input.condition} is platform-wide and cannot target an agent`);
    const params = evaluator.parseParams(input.params);
    if (!params.ok) throw validation('invalid_alert_params', params.problems.join('; '), { problems: params.problems });
    const blind = input.audienceRoles.filter((r) => !roleCanReadKind(r as Role, input.kind));
    if (blind.length) {
      throw validation('audience_cannot_read_kind', `${blind.join(', ')} cannot see ${input.kind.toLowerCase()} alerts`, { roles: blind });
    }
    if (input.agentId) {
      const [agent] = await db.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, input.agentId));
      if (!agent) throw validation('unknown_agent', 'The virtual agent does not exist');
    }
    const destinationIds = [...new Set(input.destinationIds)];
    if (destinationIds.length) {
      const found = await db.select({ id: notificationDestinations.id }).from(notificationDestinations).where(inArray(notificationDestinations.id, destinationIds));
      if (found.length !== destinationIds.length) throw validation('unknown_destination', 'One or more notification destinations do not exist');
    }
    return {
      name: input.name,
      kind: input.kind,
      condition: input.condition,
      params: params.params,
      agentId: input.agentId,
      windowSeconds: input.windowSeconds,
      severity: input.severity,
      audienceRoles: [...new Set(input.audienceRoles)],
      destinationIds,
      dedupeWindowSeconds: input.dedupeWindowSeconds,
      autoResolve: input.autoResolve,
      enabled: input.enabled,
    };
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
