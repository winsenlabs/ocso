import { Body, Controller, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { CsatInput, CsatService, SettingsService, assertConversationAccess, recordCsat, type ActorContext } from '@ocso/application';
import { notFound } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, Public, RequirePermission } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';
import { WebChatIdentityService } from '../webchat/webchat-identity.service.js';

const Id = z.uuid();

/** Staff CSAT: read responses, or record one collected outside the channel. Conversation access is checked per request. */
@Controller('v1/conversations/:conversationId/csat')
export class ConversationCsatController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(CsatService) private readonly csat: CsatService,
  ) {}

  @Capability({ name: 'quality.list_conversation_csat', summary: 'Customer satisfaction (CSAT) scores recorded for a conversation.', tags: ['csat', 'satisfaction', 'rating'] })
  @Get()
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async list(@CurrentPrincipal() principal: Principal, @Param('conversationId', { schema: Id }) conversationId: string) {
    await this.assertAccess(principal, conversationId);
    return this.csat.list(conversationId);
  }

  @Capability({ name: 'quality.record_conversation_csat', summary: "Record a CSAT score for a conversation on the customer's behalf.", risk: 'LOW_WRITE', tags: ['csat', 'satisfaction', 'rating'] })
  @Post()
  @RequirePermission(Permission.CONVERSATIONS_REPLY)
  async record(@Actor() actor: ActorContext, @Param('conversationId', { schema: Id }) conversationId: string, @Body({ schema: CsatInput }) body: CsatInput) {
    await this.assertAccess(actor.principal!, conversationId);
    return this.csat.record(actor, conversationId, body);
  }

  private async assertAccess(principal: Principal, conversationId: string): Promise<void> {
    const s = await this.settings.deployment();
    await assertConversationAccess(this.db, principal, conversationId, { execsCanViewAiActive: s.execsCanViewAiActive });
  }
}

/**
 * Customer CSAT from the web-chat widget (any embeddable channel kind: the
 * identity service resolves the channel through the registry's embed hooks).
 * Authenticated by the channel-bound visitor token; the rating always applies
 * to the visitor's own latest conversation on this channel (never a
 * caller-supplied id).
 */
@Controller('public/webchat/:publicKey/csat')
export class WebChatCsatController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WebChatIdentityService) private readonly identity: WebChatIdentityService,
  ) {}

  @Post()
  @Public()
  async submit(
    @Param('publicKey') publicKey: string,
    @Headers('origin') origin: string | undefined,
    @Headers('authorization') auth: string | undefined,
    @Req() req: object,
    @Body({ schema: CsatInput }) body: CsatInput,
  ) {
    // Same caller rules as the rest of the widget API: allowed sites, or no Origin only for native apps / passes.
    const ctx = await this.identity.access(req, publicKey, origin);
    const visitor = await this.identity.identify(ctx, auth);
    const conversation = await this.identity.conversationFor(ctx.config.id, visitor);
    if (!conversation) throw notFound('conversation', 'visitor');
    const recorded = await recordCsat(this.db, conversation.id, body.score, body.comment ?? null);
    return { recorded: true, score: recorded.score, receivedAt: recorded.receivedAt };
  }
}
