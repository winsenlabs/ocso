import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  ApprovalService,
  RouterActivateInput,
  RouterChannelsInput,
  RouterCreateInput,
  RouterDraftInput,
  RouterService,
  RouterSimulateInput,
  RouterUpdateInput,
  RouterVersionInput,
  WithApproval,
  requestApproval,
  type ActorContext,
} from '@ocso/application';
import { DomainError } from '@ocso/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';

const Id = z.uuid();
const ReachQuery = z.object({ agentId: z.uuid() });
type ApprovalBody = z.infer<typeof WithApproval>;

/**
 * Routers (PM/research/11 §5.7): drafts, frozen versions and a simulator.
 * Reads need routers.read, writes routers.manage. Activating (or resuming) a
 * version and deleting are always proposals; renaming and attaching channels
 * are proposals once the router has been approved (drafts change directly):
 * 202 `{proposal}` with `approval: {checkerId, reason}`, else 409
 * approval_required. Disabling and detaching channels are stops, never gated.
 */
@Controller('v1/routers')
export class RoutersController {
  constructor(
    @Inject(RouterService) private readonly routers: RouterService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get()
  @RequirePermission(Permission.ROUTERS_READ)
  list(@CurrentPrincipal() principal: Principal) {
    return this.routers.list(principal);
  }

  @Post()
  @RequirePermission(Permission.ROUTERS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: RouterCreateInput }) body: RouterCreateInput) {
    return this.routers.create(actor, body);
  }

  /** "Reached through": channel → router → queue for one agent (derived from the active routers). */
  @Get('reach')
  @RequirePermission(Permission.ROUTERS_READ)
  reach(@CurrentPrincipal() principal: Principal, @Query({ schema: ReachQuery }) q: z.infer<typeof ReachQuery>) {
    return this.routers.reachOfAgent(principal, q.agentId);
  }

  @Get(':id')
  @RequirePermission(Permission.ROUTERS_READ)
  async get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    const router = await this.routers.get(principal, id);
    // Maker–checker state for the header badge and the submit modal.
    return { ...router, approval: await this.approvals.objectState(principal, 'router', id) };
  }

  /** The draft definition is always editable (inert until frozen and approved); renaming an approved router is a proposal. */
  @Put(':id/draft')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  saveDraft(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterDraftInput }) body: RouterDraftInput) {
    return this.routers.saveDraft(actor, id, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterUpdateInput }) body: RouterUpdateInput, @Res({ passthrough: true }) res: Response) {
    const { approval, ...patch } = body;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'router', objectId: id, action: 'UPDATE', payload: patch }, approval, () => this.routers.update(actor, id, patch)));
  }

  @Post(':id/versions')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  freeze(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterVersionInput }) body: z.infer<typeof RouterVersionInput>) {
    return this.routers.freezeVersion(actor, id, body.reason);
  }

  /** Taking the newest version live — or resuming a disabled router — is always a proposal. */
  @Post(':id/activate')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  async activate(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterActivateInput }) body: z.infer<typeof RouterActivateInput>, @Res({ passthrough: true }) res: Response) {
    await this.routers.assertActivatable(actor.principal!, id, body.versionId);
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'router', objectId: id, action: 'ACTIVATE' }, body.approval, null));
  }

  /** Stopping is never gated: the router's channels reject new conversations (`no_router`) until it is resumed through approval. */
  @Post(':id/disable')
  @HttpCode(204)
  @RequirePermission(Permission.ROUTERS_MANAGE)
  async disable(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.routers.disable(actor, id);
  }

  /**
   * Exactly these channels. Channels left out are detached at once (a stop). New ones attach directly to a
   * draft router (it routes nothing until approved); on an approved router they are a proposal.
   */
  @Put(':id/channels')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  async channels(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterChannelsInput }) body: z.infer<typeof RouterChannelsInput>, @Res({ passthrough: true }) res: Response) {
    const { detached, attach } = await this.routers.detachExcept(actor, id, body.channelIds);
    if (!attach.length) return { detached, attached: [] as string[] };
    try {
      const outcome = await approvalResponse(
        res,
        requestApproval(this.approvals, actor, { objectKind: 'router', objectId: id, action: 'UPDATE', payload: { attachChannelIds: attach } }, body.approval, async () => {
          await this.routers.attachDirect(actor, id, attach);
          return { detached, attached: attach };
        }),
      );
      return 'proposal' in outcome ? { ...outcome, detached } : outcome;
    } catch (err) {
      // The detaches were stops and already applied: say so, so a refused attach is not read as "nothing changed".
      if (err instanceof DomainError && detached.length) throw new DomainError(err.category, err.code, `${err.message} (The channels you removed were detached.)`, { ...(err.details ?? {}), detached });
      throw err;
    }
  }

  /** Deleting a router is always a proposal (refused while channels are attached or conversations are being routed). */
  @Delete(':id')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: WithApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'router', objectId: id, action: 'DELETE' }, body.approval, null));
  }

  @Post(':id/simulate')
  @HttpCode(200)
  @RequirePermission(Permission.ROUTERS_READ)
  simulate(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterSimulateInput }) body: RouterSimulateInput) {
    return this.routers.simulate(principal, id, body);
  }
}
