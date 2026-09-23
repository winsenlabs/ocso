import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { APPROVAL_CHECK_PERMISSIONS, APPROVAL_MAKE_PERMISSIONS, Permission, type Principal } from '@ocso/auth';
import {
  ApprovalDecisionInput,
  ApprovalDecisionService,
  ApprovalEditInput,
  ApprovalObjectQuery,
  ApprovalQuery,
  ApprovalService,
  ApprovalSubmitInput,
  ApprovalWithdrawInput,
  BulkDecisionInput,
  ReassignInput,
  type ActorContext,
} from '@ocso/application';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();
type SubmitBody = z.infer<typeof ApprovalSubmitInput>;
type EditBody = z.infer<typeof ApprovalEditInput>;
type WithdrawBody = z.infer<typeof ApprovalWithdrawInput>;
type DecisionBody = z.infer<typeof ApprovalDecisionInput>;
type BulkBody = z.infer<typeof BulkDecisionInput>;
type ReassignBody = z.infer<typeof ReassignInput>;
type ListQuery = z.infer<typeof ApprovalQuery>;
type ObjectQuery = z.infer<typeof ApprovalObjectQuery>;

/**
 * The approval queue (PM/research/11 §4, 11b "api"). Reads need
 * approvals.read and are scoped to the proposals the caller may see (404
 * otherwise). Making needs any make permission here and the descriptor's exact
 * one in the service; deciding needs a check permission here and — in the
 * service — being the named checker, never the maker.
 */
@Controller('v1/approvals')
export class ApprovalsController {
  constructor(
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
    @Inject(ApprovalDecisionService) private readonly decisions: ApprovalDecisionService,
  ) {}

  @Get()
  @RequirePermission(Permission.APPROVALS_READ)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: ApprovalQuery }) q: ListQuery) {
    return this.approvals.list(principal, q);
  }

  @Get('counts')
  @RequirePermission(Permission.APPROVALS_READ)
  counts(@CurrentPrincipal() principal: Principal) {
    return this.approvals.counts(principal);
  }

  /** Registered kinds (drives the UI's filter chips). */
  @Get('kinds')
  @RequirePermission(Permission.APPROVALS_READ)
  kinds() {
    return this.approvals.kinds();
  }

  /** Who the caller may name as checker for this object, and whether a bootstrap approval is allowed. */
  @Get('checkers')
  @RequirePermission(Permission.APPROVALS_READ)
  checkers(@CurrentPrincipal() principal: Principal, @Query({ schema: ApprovalObjectQuery }) q: ObjectQuery) {
    return this.approvals.checkerCandidates(principal, q.objectKind, q.objectId);
  }

  /** An object's approval state: approved, pending proposal, whether an update needs approval (badges, submit modal). */
  @Get('state')
  @RequirePermission(Permission.APPROVALS_READ)
  state(@CurrentPrincipal() principal: Principal, @Query({ schema: ApprovalObjectQuery }) q: ObjectQuery) {
    return this.approvals.objectState(principal, q.objectKind, q.objectId);
  }

  /** Who this open proposal could be reassigned to (the reassign picker). */
  @Get(':id/checkers')
  @RequirePermission(Permission.APPROVALS_READ)
  reassignCandidates(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.approvals.reassignCandidates(principal, id);
  }

  @Get(':id')
  @RequirePermission(Permission.APPROVALS_READ)
  get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.approvals.get(principal, id);
  }

  /** For kinds without their own write endpoint; approvable endpoints accept `approval` in their body instead. */
  @Post()
  @RequireAnyPermission(...APPROVAL_MAKE_PERMISSIONS)
  submit(@Actor() actor: ActorContext, @Body({ schema: ApprovalSubmitInput }) body: SubmitBody) {
    return this.approvals.submit(actor, body);
  }

  @Patch(':id')
  @RequireAnyPermission(...APPROVAL_MAKE_PERMISSIONS)
  edit(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ApprovalEditInput }) body: EditBody) {
    return this.approvals.edit(actor, id, body);
  }

  @Post(':id/withdraw')
  @HttpCode(204)
  @RequireAnyPermission(...APPROVAL_MAKE_PERMISSIONS)
  async withdraw(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ApprovalWithdrawInput }) body: WithdrawBody) {
    await this.approvals.withdraw(actor, id, body.reason);
  }

  @Post('bulk-decision')
  @HttpCode(200)
  @RequireAnyPermission(...APPROVAL_CHECK_PERMISSIONS)
  bulk(@Actor() actor: ActorContext, @Body({ schema: BulkDecisionInput }) body: BulkBody) {
    return this.decisions.bulkDecide(actor, body);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequireAnyPermission(...APPROVAL_CHECK_PERMISSIONS)
  decide(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ApprovalDecisionInput }) body: DecisionBody) {
    return this.decisions.decide(actor, id, body);
  }

  @Post(':id/checker')
  @HttpCode(200)
  @RequireAnyPermission(Permission.APPROVALS_REASSIGN_ANY, ...APPROVAL_CHECK_PERMISSIONS)
  reassign(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ReassignInput }) body: ReassignBody) {
    return this.decisions.reassign(actor, id, body);
  }

  /** An open proposal nobody can decide any more is voided by a reassign_any holder, with a reason (audited). */
  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission(Permission.APPROVALS_REASSIGN_ANY)
  voidProposal(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ApprovalWithdrawInput }) body: WithdrawBody) {
    return this.decisions.voidProposal(actor, id, body.reason);
  }
}
