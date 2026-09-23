import { and, asc, eq, inArray, or, isNull, sql, type SQL } from 'drizzle-orm';
import type { AlertKind, DestinationEventRouting } from '@ocso/alerts';
import type { Principal } from '@ocso/auth';
import { alertRules, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { forbidden, notFound, validation } from '@ocso/domain';
import type { QueueAdapter } from '@ocso/queue';
import { readableAgentFilter } from '../agents/access.js';
import { assertChangeAllowed, isApproved, lockObject } from '../approvals/guard.js';
import { approvalStates, type ListedApprovalState } from '../approvals/object-states.js';
import { discardUnsubmittedDraft } from '../approvals/unsubmitted-draft.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { alertRuleApproval, alertRuleObjectKind } from './alert-rule-approval.js';
import { mergeAlertRule, validateAlertRule, type AlertRuleFields } from './alert-rule-validation.js';
import { assertCanManageKind, manageableKinds, readableKinds, requirePrincipal } from './audience.js';
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from './evaluators/registry.js';
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

/** What a PATCH on a rule means (see AlertRuleService.plan). */
export type AlertRuleChange =
  | { kind: 'disable' | 'activate' | 'none'; objectKind: string }
  | { kind: 'update'; objectKind: string; patch: Omit<AlertRulePatch, 'enabled'> };

/**
 * Alert rule CRUD (PM/BUILD-PLAN E8.8). TECHNICAL rules need
 * alert_rules.technical.manage, BUSINESS rules alert_rules.business.manage.
 * Maker–checker (alert-rule-approval.ts): new rules are disabled drafts;
 * turning one on, changing an approved one and deleting are proposals;
 * turning one off is immediate.
 * A rule that targets a virtual agent is visible and editable only by people
 * who can read that agent (a Lead: their teams' agents, ADR-026); rules
 * with agentId null (platform-wide) stay visible to every reader of the kind.
 */
export class AlertRuleService {
  private readonly evaluators: EvaluatorRegistry;

  constructor(
    private readonly db: Db,
    /** Kept for callers: deletions now resolve alerts inside the approval, leaving deliveries to the redispatch sweep. */
    readonly queue: QueueAdapter,
    /** The alert delivery registry (deleting a rule resolves its alerts and notifies destinations). */
    private readonly destinations: DestinationEventRouting,
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
    const where: SQL[] = [inArray(alertRules.kind, kinds), this.agentWhere(requirePrincipal(actor, 'alert_rules.read'))];
    if (query.agentId) where.push(eq(alertRules.agentId, query.agentId));
    const rows = await this.db.select().from(alertRules).where(and(...where)).orderBy(asc(alertRules.kind), asc(alertRules.name));
    return this.withApproval(this.db, rows);
  }

  async get(actor: ActorContext, id: string): Promise<AlertRuleView> {
    const row = await this.load(this.db, id, requirePrincipal(actor, 'alert_rules.read'));
    if (!this.visibleKinds(actor).includes(row.kind)) throw notFound('alert_rule', id);
    return (await this.withApproval(this.db, [row]))[0]!;
  }

  /** A new rule is always a disabled draft: inert until an approved ACTIVATE turns it on (PM/research/11 §4). */
  async create(actor: ActorContext, input: AlertRuleInput): Promise<AlertRuleView> {
    const principal = assertCanManageKind(actor, input.kind);
    const id = uuidv7();
    const row = await this.db.transaction(async (tx) => {
      const fields = await validateAlertRule(tx, this.evaluators, principal, { ...input, enabled: false });
      const [inserted] = await tx
        .insert(alertRules)
        .values({ id, ...fields, createdBy: principal.userId })
        .returning();
      await recordAudit(tx, actor, {
        action: 'alert_rule.create',
        targetType: 'alert_rule',
        targetId: id,
        summary: `Created ${input.kind.toLowerCase()} alert rule "${input.name}" (${input.condition}), off until approved`,
        after: fields,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: id });
      return inserted!;
    });
    return (await this.withApproval(this.db, [row]))[0]!;
  }

  /**
   * What a PATCH means (PM/research/11 §4): off is a stop (immediate), on is
   * ACTIVATE (a proposal), any other change applies to a draft and is an UPDATE
   * proposal once the rule has been approved. `enabled` goes alone; the kind is
   * fixed once approved (it decides who checks).
   */
  async plan(actor: ActorContext, id: string, patch: AlertRulePatch): Promise<AlertRuleChange> {
    const rule = await this.load(this.db, id, requirePrincipal(actor, 'alert_rules.manage'));
    assertCanManageKind(actor, rule.kind);
    const { enabled, ...fields } = patch;
    const changed = Object.values(fields).some((v) => v !== undefined);
    const toggles = enabled !== undefined && enabled !== rule.enabled;
    if (toggles && changed) throw validation('enabled_alone', 'Turn a rule on or off on its own, then change it');
    const objectKind = alertRuleObjectKind(rule.kind);
    if (toggles) return { kind: enabled ? 'activate' : 'disable', objectKind };
    if (!changed) return { kind: 'none', objectKind };
    if (fields.kind && fields.kind !== rule.kind) {
      assertCanManageKind(actor, fields.kind);
      if (await isApproved(this.db, objectKind, id)) throw validation('alert_rule_kind_fixed', 'An approved rule keeps its kind: create a new rule of the other kind');
    }
    return { kind: 'update', objectKind, patch: fields };
  }

  /** A draft's change, applied directly (409 approval_required once approved; approval_open while one waits). */
  async update(actor: ActorContext, id: string, patch: AlertRulePatch): Promise<AlertRuleView> {
    const row = await this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id, requirePrincipal(actor, 'alert_rules.manage'));
      const principal = assertCanManageKind(actor, before.kind);
      if (patch.kind && patch.kind !== before.kind) assertCanManageKind(actor, patch.kind);
      await assertChangeAllowed(tx, this.descriptor(before.kind), id, 'UPDATE');
      const { enabled: _enabled, ...fields } = patch;
      const merged = mergeAlertRule(before, fields as Partial<AlertRuleFields>);
      const next = await validateAlertRule(tx, this.evaluators, principal, merged);
      const [updated] = await tx
        .update(alertRules)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(alertRules.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'alert_rule.update',
        targetType: 'alert_rule',
        targetId: id,
        summary: `Updated alert rule "${updated!.name}"`,
        before,
        after: fields,
      });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: id });
      return updated!;
    });
    return (await this.withApproval(this.db, [row]))[0]!;
  }

  /** Turning a rule off is a stop: immediate, never a proposal, never refused because a proposal is open. */
  async disable(actor: ActorContext, id: string): Promise<AlertRuleView> {
    const row = await this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id, requirePrincipal(actor, 'alert_rules.manage'));
      assertCanManageKind(actor, before.kind);
      const [updated] = await tx.update(alertRules).set({ enabled: false, updatedAt: new Date() }).where(eq(alertRules.id, id)).returning();
      await recordAudit(tx, actor, { action: 'alert_rule.disable', targetType: 'alert_rule', targetId: id, summary: `Turned off alert rule "${before.name}"`, before: { enabled: before.enabled }, after: { enabled: false } });
      await emitEvent(tx, actor, 'config.changed', { area: 'alert_rules', entityId: id });
      return updated!;
    });
    return (await this.withApproval(this.db, [row]))[0]!;
  }

  /** Undo a rule this request created when its ACTIVATE could not be submitted (never once anything was proposed). */
  async discardFailedCreate(actor: ActorContext, rule: Pick<AlertRuleView, 'id' | 'name' | 'kind'>): Promise<void> {
    await discardUnsubmittedDraft(this.db, actor, {
      kind: alertRuleObjectKind(rule.kind),
      id: rule.id,
      name: `"${rule.name}"`,
      remove: async (tx) => void (await tx.delete(alertRules).where(and(eq(alertRules.id, rule.id), eq(alertRules.enabled, false)))),
    });
  }

  /** The approval kind of a rule the caller may manage (for DELETE and other proposals made through the routes). */
  async objectKindOf(actor: ActorContext, id: string): Promise<string> {
    const rule = await this.load(this.db, id, requirePrincipal(actor, 'alert_rules.manage'));
    assertCanManageKind(actor, rule.kind);
    return alertRuleObjectKind(rule.kind);
  }

  private descriptor(kind: AlertKind) {
    return alertRuleApproval(kind, { alertRouting: this.destinations, alertEvaluators: this.evaluators });
  }

  private async lock(tx: DbOrTx, id: string, principal: Principal): Promise<AlertRuleRow> {
    // The approval spine's default lock key for this object, then the row.
    const [kind] = await tx.select({ kind: alertRules.kind }).from(alertRules).where(eq(alertRules.id, id));
    if (kind) await lockObject(tx, `${alertRuleObjectKind(kind.kind)}:${id}`);
    const [row] = await tx.select().from(alertRules).where(and(eq(alertRules.id, id), this.agentWhere(principal))).for('update');
    if (!row) throw notFound('alert_rule', id);
    return row;
  }

  private async withApproval(db: DbOrTx, rows: AlertRuleRow[]): Promise<AlertRuleView[]> {
    const states = new Map<string, ListedApprovalState>();
    for (const kind of ['BUSINESS', 'TECHNICAL'] as const) {
      const ids = rows.filter((r) => r.kind === kind).map((r) => r.id);
      for (const [id, state] of await approvalStates(db, alertRuleObjectKind(kind), ids)) states.set(id, state);
    }
    return rows.map((r) => ({ ...this.view(r), approval: states.get(r.id) ?? { approved: false, pending: null } }));
  }

  private visibleKinds(actor: ActorContext): AlertKind[] {
    const principal = requirePrincipal(actor, 'alert_rules.read');
    return [...new Set([...readableKinds(principal), ...manageableKinds(principal)])];
  }

  /** Platform-wide rules, or rules of an agent the principal can read. */
  private agentWhere(principal: Principal): SQL {
    const scoped = readableAgentFilter(principal, alertRules.agentId);
    return scoped ? or(isNull(alertRules.agentId), scoped)! : sql`true`;
  }

  private async load(db: DbOrTx, id: string, principal: Principal): Promise<AlertRuleRow> {
    const [row] = await db.select().from(alertRules).where(and(eq(alertRules.id, id), this.agentWhere(principal)));
    if (!row) throw notFound('alert_rule', id);
    return row;
  }

  private view(row: AlertRuleRow): AlertRuleView {
    return toRuleView(row, this.evaluators.find(row.condition)?.label ?? null);
  }
}
