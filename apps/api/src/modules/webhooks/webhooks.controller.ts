import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { WEBHOOK_EVENT_TYPES, WebhookDeliveryService, WebhookInput, WebhookPatch, WebhookService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();
const DeliveriesQuery = z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional() });
type DeliveriesQuery = z.infer<typeof DeliveriesQuery>;

@Controller('v1')
export class WebhooksController {
  constructor(
    @Inject(WebhookService) private readonly webhooks: WebhookService,
    @Inject(WebhookDeliveryService) private readonly delivery: WebhookDeliveryService,
  ) {}

  @Get('webhooks')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  list(@Actor() actor: ActorContext) {
    return this.webhooks.list(actor);
  }

  @Get('webhooks/event-types')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  eventTypes() {
    return WEBHOOK_EVENT_TYPES;
  }

  /** Returns the signing secret once; it is never readable again. */
  @Post('webhooks')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: WebhookInput }) body: WebhookInput) {
    return this.webhooks.create(actor, body);
  }

  @Patch('webhooks/:id')
  @HttpCode(204)
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: WebhookPatch }) body: WebhookPatch): Promise<void> {
    await this.webhooks.update(actor, id, body);
  }

  @Post('webhooks/:id/rotate-secret')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  rotate(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.webhooks.rotateSecret(actor, id);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string): Promise<void> {
    await this.webhooks.remove(actor, id);
  }

  @Post('webhooks/:id/test')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async test(@Param('id', { schema: Id }) id: string) {
    await this.webhooks.get(id);
    return this.delivery.sendTest(id);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  deliveries(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Query({ schema: DeliveriesQuery }) q: DeliveriesQuery) {
    return this.webhooks.deliveries(actor, id, q.status);
  }

  @Post('webhook-deliveries/:id/retry')
  @HttpCode(204)
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async retry(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string): Promise<void> {
    await this.webhooks.retry(actor, id);
  }
}
