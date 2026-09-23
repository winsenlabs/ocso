import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Permission, type Principal } from '@ocso/auth';
import { COPILOT_STYLES, CopilotService } from '@ocso/agent-runtime';
import type { ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';

const Id = z.uuid();
const DraftInput = z.object({ style: z.enum(COPILOT_STYLES).optional(), baseText: z.string().max(4_000).optional() });
type DraftInput = z.infer<typeof DraftInput>;
const OutcomeInput = z.object({ outcome: z.enum(['INSERTED', 'DISMISSED']) });
type OutcomeInput = z.infer<typeof OutcomeInput>;

/** Copilot drafts (design/01 "suggested reply" card). Drafts are never sent by OCSO. */
@Controller('v1')
export class CopilotController {
  constructor(
    @Inject(CopilotService) private readonly copilot: CopilotService,
    @Inject(ConversationAccessService) private readonly access: ConversationAccessService,
  ) {}

  @Capability({ name: 'copilot.draft_reply', summary: 'Draft a reply suggestion for a conversation (optionally from your text, in a tone).', risk: 'LOW_WRITE' })
  @Post('conversations/:id/copilot/draft')
  @RequirePermission(Permission.COPILOT_USE)
  async draft(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: DraftInput }) body: DraftInput) {
    await this.access.assert(actor.principal!, id);
    return this.copilot.draft(actor, id, body);
  }

  @Capability({ name: 'copilot.get_latest_suggestion', summary: 'Get the latest copilot reply suggestion for a conversation.' })
  @Get('conversations/:id/copilot/latest')
  @RequirePermission(Permission.COPILOT_USE)
  async latest(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Res({ passthrough: true }) res: Response) {
    await this.access.assert(principal, id);
    const view = await this.copilot.latest(id);
    if (!view) res.status(204);
    return view ?? undefined;
  }

  @Capability({ name: 'copilot.record_suggestion_outcome', summary: 'Record whether a copilot suggestion was inserted or dismissed.', risk: 'LOW_WRITE' })
  @Post('copilot-suggestions/:id/outcome')
  @HttpCode(204)
  @RequirePermission(Permission.COPILOT_USE)
  async outcome(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: OutcomeInput }) body: OutcomeInput): Promise<void> {
    await this.access.assert(actor.principal!, await this.copilot.conversationOf(id));
    await this.copilot.recordOutcome(actor, id, body.outcome);
  }
}
