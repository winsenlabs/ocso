import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AlertRuleInput, AlertRuleListQuery, AlertRulePatch, AlertRuleService, ApprovalService, WithApproval, alertRuleObjectKind, requestApproval, submitOrDiscard, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, Capability } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';

const CreateBody = AlertRuleInput.extend(WithApproval.shape);
type CreateBody = z.input<typeof CreateBody>;
const PatchBody = AlertRulePatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;
type ApprovalBody = z.infer<typeof WithApproval>;

/**
 * Alert rules. The required permission depends on the rule's kind
 * (alert_rules.technical.manage vs alert_rules.business.manage), so it is
 * enforced in AlertRuleService against the stored and requested kind.
 * Maker–checker (PM/research/11 §4): a new rule is a disabled draft (201);
 * turning it on is ACTIVATE, a change to an approved rule is UPDATE and deleting
 * is DELETE — 202 `{proposal}` with `approval`, else 409 approval_required
 * (kinds `alert_rule` and `alert_rule_technical`); turning a rule off is immediate.
 */
@Controller('v1/alert-rules')
export class AlertRulesController {
  constructor(
    @Inject(AlertRuleService) private readonly rules: AlertRuleService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Capability({ name: 'alerts.list_alert_rules', summary: 'List the alert rules you can see (business and technical).', tags: ['rule'] })
  @Get()
  @Authenticated()
  list(@Actor() actor: ActorContext, @Query({ schema: AlertRuleListQuery }) query: AlertRuleListQuery) {
    return this.rules.list(actor, query);
  }

  /** Evaluator catalogue: condition, kinds, method and params JSON schema. */
  @Capability({ name: 'alerts.list_alert_conditions', summary: 'List the conditions an alert rule can watch, with their parameters.', tags: ['rule', 'condition'] })
  @Get('conditions')
  @Authenticated()
  conditions(@Actor() actor: ActorContext) {
    return this.rules.conditions(actor);
  }

  @Capability({ name: 'alerts.get_alert_rule', summary: 'Get one alert rule.', tags: ['rule'] })
  @Get(':id')
  @Authenticated()
  get(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.rules.get(actor, id);
  }

  /** 201 the draft (off). With `approval`, turning it on is proposed in the same call: 202 `{ rule, proposal }`. */
  @Capability({ name: 'alerts.create_alert_rule', summary: 'Create an alert rule (it starts off; turning it on needs approval).', approvalKind: 'alert_rule', tags: ['rule'] })
  @Post()
  @Authenticated()
  async create(@Actor() actor: ActorContext, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    const rule = await this.rules.create(actor, input as AlertRuleInput);
    const target = { objectKind: alertRuleObjectKind(rule.kind), objectId: rule.id, action: 'ACTIVATE' as const };
    if (!approval) return { ...rule, approvalRequired: target };
    // A submission that fails (no eligible checker, bootstrap refused) fails the whole request: the draft goes too.
    const outcome = await submitOrDiscard(() => requestApproval(this.approvals, actor, target, approval, null), () => this.rules.discardFailedCreate(actor, rule));
    res.status(202);
    return { rule, proposal: outcome.kind === 'proposed' ? outcome.proposal : null };
  }

  /** `enabled` goes alone: false is an immediate stop (200); true is ACTIVATE (202/409). Other fields: 200 for a draft, else 202/409. */
  @Capability({ name: 'alerts.update_alert_rule', summary: 'Change an alert rule: turning it off applies at once; turning it on, or editing an approved rule, needs approval.', stopWhen: { enabled: false }, approvalKind: 'alert_rule', tags: ['rule', 'disable', 'mute'] })
  @Patch(':id')
  @Authenticated()
  async update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...patch } = body;
    const change = await this.rules.plan(actor, id, patch);
    const target = { objectKind: change.objectKind, objectId: id };
    switch (change.kind) {
      case 'disable':
        return this.rules.disable(actor, id);
      case 'activate':
        return approvalResponse(res, requestApproval(this.approvals, actor, { ...target, action: 'ACTIVATE' }, approval, null));
      case 'update': {
        const { kind: _kind, ...fields } = change.patch;
        return approvalResponse(res, requestApproval(this.approvals, actor, { ...target, action: 'UPDATE', payload: fields }, approval, () => this.rules.update(actor, id, change.patch)));
      }
      default:
        return this.rules.get(actor, id);
    }
  }

  /** Deleting is always a proposal (it resolves the rule's open alerts once approved): 202 `{proposal}`, else 409. */
  @Capability({ name: 'alerts.delete_alert_rule', summary: 'Delete an alert rule (always needs approval).', approvalKind: 'alert_rule', tags: ['rule'] })
  @Delete(':id')
  @Authenticated()
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: WithApproval.optional() }) body: ApprovalBody | undefined, @Res({ passthrough: true }) res: Response) {
    const objectKind = await this.rules.objectKindOf(actor, id);
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind, objectId: id, action: 'DELETE' }, body?.approval, null));
  }
}
