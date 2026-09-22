import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { QueueInput, QueueService, SlaPolicyInput, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();
const QueuePatch = QueueInput.partial();
type QueuePatch = z.infer<typeof QueuePatch>;

/** Queues, team eligibility and SLA policies (CS Lead). */
@Controller('v1')
export class RoutingController {
  constructor(@Inject(QueueService) private readonly queues: QueueService) {}

  @Get('queues')
  @RequirePermission(Permission.QUEUES_READ)
  list() {
    return this.queues.list();
  }

  @Post('queues')
  @RequirePermission(Permission.QUEUES_MANAGE)
  async create(@Actor() actor: ActorContext, @Body({ schema: QueueInput }) body: QueueInput) {
    return { id: await this.queues.create(actor, body) };
  }

  @Patch('queues/:id')
  @HttpCode(204)
  @RequirePermission(Permission.QUEUES_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: QueuePatch }) body: QueuePatch) {
    await this.queues.update(actor, id, body);
  }

  @Get('sla-policies')
  @RequirePermission(Permission.QUEUES_READ)
  slaPolicies() {
    return this.queues.listSlaPolicies();
  }

  @Post('sla-policies')
  @RequirePermission(Permission.SLA_MANAGE)
  async createSla(@Actor() actor: ActorContext, @Body({ schema: SlaPolicyInput }) body: SlaPolicyInput) {
    return { id: await this.queues.saveSlaPolicy(actor, null, body) };
  }

  @Put('sla-policies/:id')
  @RequirePermission(Permission.SLA_MANAGE)
  async updateSla(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: SlaPolicyInput }) body: SlaPolicyInput) {
    return { id: await this.queues.saveSlaPolicy(actor, id, body) };
  }
}
