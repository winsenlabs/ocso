import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { PricingInput, PricingPatch, PricingService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

/** Price table for usage cost metadata (micro-units per 1M tokens). */
@Controller('v1/model-pricing')
export class ModelPricingController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Get()
  @RequirePermission(Permission.PRICING_MANAGE)
  list(@Actor() actor: ActorContext) {
    return this.pricing.list(actor);
  }

  @Post()
  @RequirePermission(Permission.PRICING_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: PricingInput }) body: PricingInput) {
    return this.pricing.create(actor, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.PRICING_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: PricingPatch }) body: PricingPatch) {
    return this.pricing.update(actor, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.PRICING_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.pricing.delete(actor, id);
  }
}
