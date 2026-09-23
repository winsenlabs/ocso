import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, QueueBaseline, QueueInput, QueuePatch, QueueService, SlaPolicyInput, WithApproval, isEmptyPatch, requestApproval, type ActorContext } from '@ocso/application';
import { DomainError, ErrorCategory } from '@ocso/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';

const Id = z.uuid();
const QueueBody = QueueInput.extend(WithApproval.shape);
type QueueBody = z.infer<typeof QueueBody>;
const QueuePatchBody = QueuePatch.extend(WithApproval.shape).extend({ baseline: QueueBaseline.optional() });
type QueuePatchBody = z.infer<typeof QueuePatchBody>;
const SlaBody = SlaPolicyInput.extend(WithApproval.shape);
type SlaBody = z.infer<typeof SlaBody>;
type ApprovalBody = z.infer<typeof WithApproval>;

/**
 * Queues, team eligibility and SLA policies (Lead). Maker–checker
 * (PM/research/11 §4, §5.5): a new queue or SLA policy is a draft, written
 * directly; its first approval (CREATE) is what lets routers use it. Once
 * approved — or while live routing reaches it — a change is a proposal: 202
 * `{proposal}` with `approval`, else 409 approval_required. Unlinking your
 * own team and removing transfer targets are stops and apply at once.
 */
@Controller('v1')
export class RoutingController {
  constructor(
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Capability({ name: 'routing.list_queues', summary: 'List queues and their settings.' })
  @Get('queues')
  @RequirePermission(Permission.QUEUES_READ)
  list() {
    return this.queues.list();
  }

  /** Maker–checker state of one queue (badge + submit modal). */
  @Capability({ name: 'routing.get_queue_approval_state', summary: "A queue's approval state." })
  @Get('queues/:id/approval')
  @RequirePermission(Permission.QUEUES_READ)
  approval(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.approvals.objectState(principal, 'queue', id);
  }

  /** A draft queue; with `approval` it is also submitted for its first approval (202 `{id, proposal}`). */
  @Capability({ name: 'routing.create_queue', summary: 'Create a queue as a draft (its first approval can be requested at once).' })
  @Post('queues')
  @RequirePermission(Permission.QUEUES_MANAGE)
  async create(@Actor() actor: ActorContext, @Body({ schema: QueueBody }) body: QueueBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    const id = await this.queues.create(actor, input);
    if (!approval) return { id };
    const outcome = await approvalResponse(res, requestApproval<never>(this.approvals, actor, { objectKind: 'queue', objectId: id, action: 'CREATE' }, approval, null));
    return { id, ...outcome };
  }

  /** Submit a draft queue for its first approval (always a proposal). */
  @Capability({ name: 'routing.submit_queue', summary: 'Submit a draft queue for its first approval.' })
  @Post('queues/:id/submit')
  @RequirePermission(Permission.QUEUES_MANAGE)
  submit(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: WithApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'queue', objectId: id, action: 'CREATE' }, body.approval, null));
  }

  /**
   * Stops apply at once (they never wait for, or are locked by, a proposal); the rest applies directly to a
   * draft queue, else becomes a proposal. `applied` says which stops went through when the rest answers 409.
   * `baseline` (the lists the editor loaded) makes removals exact: only ids it saw and unticked are removed.
   */
  @Capability({ name: 'routing.update_queue', summary: 'Change a queue: stops apply at once, other changes to an approved queue need approval.' })
  @Patch('queues/:id')
  @RequirePermission(Permission.QUEUES_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: QueuePatchBody }) body: QueuePatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, baseline, ...patch } = body;
    const plan = await this.queues.planUpdate(actor.principal!, id, patch, baseline);
    await this.queues.applyStops(actor, id, plan.stops);
    const applied = { removedTeamIds: plan.stops.removeTeamIds, removedTransferTargetIds: plan.stops.removeTransferTargetIds };
    if (isEmptyPatch(plan.change)) {
      res.status(204);
      return undefined;
    }
    try {
      const outcome = await approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'queue', objectId: id, action: 'UPDATE', payload: plan.change }, approval, () => this.queues.applyChange(actor, id, plan.change)));
      if (outcome && typeof outcome === 'object' && 'proposal' in outcome) return { ...outcome, applied };
      res.status(204);
      return undefined;
    } catch (err) {
      if (err instanceof DomainError && err.code === 'approval_required' && (applied.removedTeamIds.length || applied.removedTransferTargetIds.length)) {
        throw new DomainError(ErrorCategory.CONFLICT, 'approval_required', `${err.message} (The removals you made were applied.)`, { ...(err.details ?? {}), applied });
      }
      throw err;
    }
  }

  @Capability({ name: 'routing.list_sla_policies', summary: 'List SLA policies (response and resolution targets).', tags: ['sla', 'target'] })
  @Get('sla-policies')
  @RequirePermission(Permission.QUEUES_READ)
  slaPolicies() {
    return this.queues.listSlaPolicies();
  }

  @Capability({ name: 'routing.get_sla_policy_approval_state', summary: "An SLA policy's approval state.", tags: ['sla'] })
  @Get('sla-policies/:id/approval')
  @RequirePermission(Permission.QUEUES_READ)
  slaApproval(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.approvals.objectState(principal, 'sla_policy', id);
  }

  @Capability({ name: 'routing.create_sla_policy', summary: 'Create an SLA policy as a draft (its first approval can be requested at once).', tags: ['sla'] })
  @Post('sla-policies')
  @RequirePermission(Permission.SLA_MANAGE)
  async createSla(@Actor() actor: ActorContext, @Body({ schema: SlaBody }) body: SlaBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    const id = await this.queues.saveSlaPolicy(actor, null, input);
    if (!approval) return { id };
    const outcome = await approvalResponse(res, requestApproval<never>(this.approvals, actor, { objectKind: 'sla_policy', objectId: id, action: 'CREATE' }, approval, null));
    return { id, ...outcome };
  }

  @Capability({ name: 'routing.submit_sla_policy', summary: 'Submit a draft SLA policy for its first approval.', tags: ['sla'] })
  @Post('sla-policies/:id/submit')
  @RequirePermission(Permission.SLA_MANAGE)
  submitSla(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: WithApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'sla_policy', objectId: id, action: 'CREATE' }, body.approval, null));
  }

  @Capability({ name: 'routing.update_sla_policy', summary: "Change an SLA policy (an approved policy's change needs approval).", tags: ['sla'] })
  @Put('sla-policies/:id')
  @RequirePermission(Permission.SLA_MANAGE)
  async updateSla(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: SlaBody }) body: SlaBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    const outcome = await approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'sla_policy', objectId: id, action: 'UPDATE', payload: input }, approval, () => this.queues.saveSlaPolicy(actor, id, input)));
    return typeof outcome === 'string' ? { id: outcome } : { id, ...outcome };
  }
}
