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
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();

/**
 * Prompt correction workflow (docs/09 §7): record from a conversation turn,
 * stage into the prompt draft (prompts.edit is also enforced), or reject.
 */
@Controller('v1/corrections')
export class CorrectionsController {
  constructor(@Inject(CorrectionService) private readonly corrections: CorrectionService) {}

  @Capability({ name: 'quality.list_corrections', summary: "List corrections (fixes to an agent's prompt proposed from real conversations).", tags: ['correction', 'fix'] })
  @Get()
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: CorrectionQuery }) q: CorrectionQuery) {
    return this.corrections.list(principal, q);
  }

  @Capability({ name: 'quality.get_correction', summary: 'Get one correction.', tags: ['correction'] })
  @Get(':id')
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.corrections.get(principal, id);
  }

  @Capability({ name: 'quality.create_correction', summary: 'Propose a correction from a conversation: what the agent did and what it should do.', risk: 'LOW_WRITE', tags: ['correction', 'fix', 'feedback'] })
  @Post()
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CorrectionInput }) body: CorrectionInput) {
    return this.corrections.create(actor, body);
  }

  @Capability({ name: 'quality.stage_correction', summary: "Stage a correction into the agent's prompt draft.", tags: ['correction', 'prompt'] })
  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  stage(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: StageCorrectionInput }) body: StageCorrectionInput) {
    return this.corrections.stage(actor, id, body);
  }

  @Capability({ name: 'quality.reject_correction', summary: 'Reject a correction, with a reason.', risk: 'LOW_WRITE', tags: ['correction'] })
  @Post(':id/reject')
  @HttpCode(204)
  @RequirePermission(Permission.CORRECTIONS_MANAGE)
  async reject(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RejectCorrectionInput }) body: RejectCorrectionInput) {
    await this.corrections.reject(actor, id, body);
  }
}
