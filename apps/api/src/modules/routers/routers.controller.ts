import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  RouterActivateInput,
  RouterChannelsInput,
  RouterCreateInput,
  RouterDraftInput,
  RouterService,
  RouterSimulateInput,
  RouterVersionInput,
  type ActorContext,
} from '@ocso/application';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();

/**
 * Routers (PM/research/11 §5.7): drafts, frozen versions and a simulator.
 * Reads need routers.read, writes routers.manage. Activation and channel
 * attachment change live routing, so they are approvals: until the approval
 * spine handles routers they answer 409 approval_required.
 */
@Controller('v1/routers')
export class RoutersController {
  constructor(@Inject(RouterService) private readonly routers: RouterService) {}

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

  @Get(':id')
  @RequirePermission(Permission.ROUTERS_READ)
  get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.routers.get(principal, id);
  }

  @Put(':id/draft')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  saveDraft(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterDraftInput }) body: RouterDraftInput) {
    return this.routers.saveDraft(actor, id, body);
  }

  @Post(':id/versions')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  freeze(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterVersionInput }) body: z.infer<typeof RouterVersionInput>) {
    return this.routers.freezeVersion(actor, id, body.reason);
  }

  @Post(':id/activate')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  activate(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterActivateInput }) body: z.infer<typeof RouterActivateInput>) {
    return this.routers.requestActivation(actor, id, body.versionId);
  }

  /** Stopping is never gated: the router's channels reject new messages (`no_router`) until another router is attached. */
  @Post(':id/disable')
  @HttpCode(204)
  @RequirePermission(Permission.ROUTERS_MANAGE)
  async disable(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.routers.disable(actor, id);
  }

  @Put(':id/channels')
  @RequirePermission(Permission.ROUTERS_MANAGE)
  channels(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterChannelsInput }) _body: z.infer<typeof RouterChannelsInput>) {
    return this.routers.requestChannels(actor, id);
  }

  @Post(':id/simulate')
  @HttpCode(200)
  @RequirePermission(Permission.ROUTERS_READ)
  simulate(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Body({ schema: RouterSimulateInput }) body: RouterSimulateInput) {
    return this.routers.simulate(principal, id, body);
  }
}
