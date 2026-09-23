import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { AcknowledgeAlertInput, AlertListQuery, AlertService, ResolveAlertInput, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequirePermission } from '../../common/decorators.js';

const CountsQuery = z.object({ agentId: z.uuid().optional() });
type CountsQuery = z.infer<typeof CountsQuery>;
type ListQuery = z.output<typeof AlertListQuery>;

/**
 * Alert inbox. Reads are open to any signed-in user because visibility is
 * per alert (audience role AND kind read permission), enforced in AlertService.
 */
@Controller('v1/alerts')
export class AlertsController {
  constructor(@Inject(AlertService) private readonly alerts: AlertService) {}

  @Get()
  @Authenticated()
  list(@Actor() actor: ActorContext, @Query({ schema: AlertListQuery }) query: ListQuery) {
    return this.alerts.list(actor, query);
  }

  /** Nav-badge counts; declared before `:id` so it is not captured as an id. */
  @Get('counts')
  @Authenticated()
  counts(@Actor() actor: ActorContext, @Query({ schema: CountsQuery }) query: CountsQuery) {
    return this.alerts.counts(actor, query);
  }

  @Get(':id')
  @Authenticated()
  get(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.alerts.get(actor, id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @RequirePermission(Permission.ALERTS_ACKNOWLEDGE)
  acknowledge(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: AcknowledgeAlertInput }) body: AcknowledgeAlertInput) {
    return this.alerts.acknowledge(actor, id, body);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermission(Permission.ALERTS_ACKNOWLEDGE)
  resolve(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: ResolveAlertInput }) body: ResolveAlertInput) {
    return this.alerts.resolve(actor, id, body);
  }
}
