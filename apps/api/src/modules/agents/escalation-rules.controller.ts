import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Permission, type Principal } from '@ocso/auth';
import {
  ApprovalService,
  ESCALATION_RULE_KIND,
  EscalationRuleInput,
  EscalationRulePatch,
  EscalationRuleService,
  WithApproval,
  requestApproval,
  submitOrDiscard,
  type ActorContext,
} from '@ocso/application';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';

const Id = z.uuid();
const CreateBody = EscalationRuleInput.extend(WithApproval.shape);
type CreateBody = z.input<typeof CreateBody>;
const UpdateBody = EscalationRulePatch.extend(WithApproval.shape);
type UpdateBody = z.infer<typeof UpdateBody>;
type ApprovalBody = z.infer<typeof WithApproval>;

/**
 * Escalation rules of an agent (design/02 Escalation tab), under maker–checker
 * (PM/research/11 §4): a new rule is a disabled draft (201); turning it on is an
 * `escalation_rule` ACTIVATE proposal; once approved, every change is an UPDATE
 * proposal and deleting always is (202 `{proposal}` with `approval`, else 409
 * approval_required); turning a rule off applies at once, even while a proposal
 * is open. Scoped to agents the caller reads (reads) or whose owning team they
 * are in (writes); 404 otherwise (ADR-026).
 */
@Controller('v1/agents/:agentId/escalation-rules')
export class EscalationRulesController {
  constructor(
    @Inject(EscalationRuleService) private readonly rules: EscalationRuleService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get()
  @RequirePermission(Permission.AGENTS_READ)
  list(@CurrentPrincipal() principal: Principal, @Param('agentId', { schema: Id }) agentId: string) {
    return this.rules.list(principal, agentId);
  }

  /** 201 the draft (off). With `approval`, its ACTIVATE is proposed in the same call: 202 `{ rule, proposal }`. */
  @Post()
  @RequirePermission(Permission.ESCALATION_MANAGE)
  async create(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    const rule = await this.rules.create(actor, agentId, input as EscalationRuleInput);
    if (!approval) return { ...rule, approvalRequired: { objectKind: ESCALATION_RULE_KIND, objectId: rule.id, action: 'ACTIVATE' } };
    // A submission that fails (no eligible checker, bootstrap refused) fails the whole request: the draft goes too.
    const outcome = await submitOrDiscard(
      () => requestApproval(this.approvals, actor, { objectKind: ESCALATION_RULE_KIND, objectId: rule.id, action: 'ACTIVATE' }, approval, null),
      () => this.rules.discardFailedCreate(actor, rule),
    );
    res.status(202);
    return { rule, proposal: outcome.kind === 'proposed' ? outcome.proposal : null };
  }

  /** `enabled` goes alone: false is an immediate stop (200); true is ACTIVATE (202/409). Other fields: 200 for a draft, else 202/409. */
  @Put(':ruleId')
  @RequirePermission(Permission.ESCALATION_MANAGE)
  async update(
    @Actor() actor: ActorContext,
    @Param('agentId', { schema: Id }) agentId: string,
    @Param('ruleId', { schema: Id }) ruleId: string,
    @Body({ schema: UpdateBody }) body: UpdateBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { approval, ...patch } = body;
    const change = await this.rules.plan(actor, agentId, ruleId, patch);
    const target = { objectKind: ESCALATION_RULE_KIND, objectId: ruleId };
    switch (change.kind) {
      case 'disable':
        return this.rules.disable(actor, agentId, ruleId);
      case 'activate':
        return approvalResponse(res, requestApproval(this.approvals, actor, { ...target, action: 'ACTIVATE' }, approval, null));
      case 'update':
        return approvalResponse(res, requestApproval(this.approvals, actor, { ...target, action: 'UPDATE', payload: change.patch }, approval, () => this.rules.update(actor, agentId, ruleId, change.patch)));
      default:
        return this.rules.assertRuleOf(actor, agentId, ruleId);
    }
  }

  /** Deleting is always a proposal: 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Delete(':ruleId')
  @RequirePermission(Permission.ESCALATION_MANAGE)
  async remove(
    @Actor() actor: ActorContext,
    @Param('agentId', { schema: Id }) agentId: string,
    @Param('ruleId', { schema: Id }) ruleId: string,
    @Body({ schema: WithApproval.optional() }) body: ApprovalBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.rules.assertRuleOf(actor, agentId, ruleId);
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: ESCALATION_RULE_KIND, objectId: ruleId, action: 'DELETE' }, body?.approval, null));
  }
}
