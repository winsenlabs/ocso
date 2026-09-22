import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { DestinationInput, DestinationPatch, NotificationDestinationService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';

/** Alert delivery targets. Secrets are write-only: accepted on create/update, never returned. */
@Controller('v1/notification-destinations')
export class NotificationDestinationsController {
  constructor(@Inject(NotificationDestinationService) private readonly destinations: NotificationDestinationService) {}

  /** Managers and rule editors (to attach destinations); configuration only for managers. */
  @Get()
  @Authenticated()
  list(@Actor() actor: ActorContext) {
    return this.destinations.list(actor);
  }

  /**
   * Registered destination kinds: label, config form (JSON Schema), secret
   * field and the lifecycle events each receives. Same audience as the list.
   */
  @Get('kinds')
  @RequireAnyPermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE, Permission.ALERT_RULES_TECHNICAL_MANAGE, Permission.ALERT_RULES_BUSINESS_MANAGE)
  kinds(@Actor() actor: ActorContext) {
    return this.destinations.kinds(actor);
  }

  @Get(':id')
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  get(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.destinations.get(actor, id);
  }

  @Post()
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: DestinationInput }) body: DestinationInput) {
    return this.destinations.create(actor, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: DestinationPatch }) body: DestinationPatch) {
    return this.destinations.update(actor, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.destinations.delete(actor, id);
  }

  /** Sends a synthetic alert immediately and reports the adapter result. */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  test(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.destinations.test(actor, id);
  }
}
