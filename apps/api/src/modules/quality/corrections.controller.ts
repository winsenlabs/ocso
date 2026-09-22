import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  CorrectionInput,
  CorrectionQuery,
  CorrectionService,
  RejectCorrectionInput,
  StageCorrectionInput,
  type ActorContext,
} from '@ocso/application';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();

/**
 * Prompt correction workflow (docs/09 §7): record from a conversation turn,
 * stage into the prompt draft (prompts.edit is also enforced), or reject.
 */
@Controller('v1/corrections')
export class CorrectionsController {
  constructor(@Inject(CorrectionService) private readonly corrections: CorrectionService) {}

  @Get()
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: CorrectionQuery }) q: CorrectionQuery) {
    return this.corrections.list(principal, q);
  }

  @Get(':id')
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.corrections.get(principal, id);
  }

  @Post()
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CorrectionInput }) body: CorrectionInput) {
    return this.corrections.create(actor, body);
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  stage(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: StageCorrectionInput }) body: StageCorrectionInput) {
    return this.corrections.stage(actor, id, body);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  async reject(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RejectCorrectionInput }) body: RejectCorrectionInput) {
    await this.corrections.reject(actor, id, body);
  }
}
