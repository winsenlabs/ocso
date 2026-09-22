import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  HumanControlService,
  HumanReplyInput,
  InboxQuery,
  InboxService,
  NoteInput,
  ResolveInput,
  ReturnToAiInput,
  SetTagsInput,
  TagSuggestionQuery,
  TransferInput,
  addNote,
  loadConversationDetail,
  loadTimeline,
  sendHumanReply,
  setConversationTags,
  tagSuggestions,
  type ActorContext,
} from '@ocso/application';
import { notFound } from '@ocso/domain';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import type { BlobStore } from '@ocso/blob';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { BLOB_STORE, DB, QUEUE } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from './conversation-access.service.js';

const Id = z.uuid();
const TimelineQuery = z.object({ afterSeq: z.coerce.number().int().min(0).optional() });
type TimelineQuery = z.infer<typeof TimelineQuery>;
type Transfer = z.infer<typeof TransferInput>;
type Resolve = z.infer<typeof ResolveInput>;
type ReturnToAi = z.infer<typeof ReturnToAiInput>;

/** CS workspace API (design/01): inbox, detail, timeline and human actions. */
@Controller('v1/conversations')
export class ConversationsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueueAdapter,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(HumanControlService) private readonly control: HumanControlService,
    @Inject(ConversationAccessService) private readonly access: ConversationAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async list(@CurrentPrincipal() principal: Principal, @Query({ schema: InboxQuery }) q: InboxQuery) {
    return this.inbox.list(principal, await this.access.policy(), q);
  }

  /** Most used tags on conversations the caller can see (autocomplete). Declared before `:id`. */
  @Get('tags')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async tags(@CurrentPrincipal() principal: Principal, @Query({ schema: TagSuggestionQuery }) q: TagSuggestionQuery) {
    return tagSuggestions(this.db, principal, await this.access.policy(), q);
  }

  @Get(':id')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async detail(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(principal, id);
    const detail = await loadConversationDetail(this.db, id);
    if (!detail) throw notFound('conversation', id);
    return detail;
  }

  @Get(':id/timeline')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async timeline(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Query({ schema: TimelineQuery }) q: TimelineQuery) {
    await this.access.assert(principal, id);
    const items = await loadTimeline(this.db, id, { afterSeq: q.afterSeq });
    return Promise.all(items.map(async (item) => (item.kind === 'message' ? { ...item, parts: await this.access.signParts(item.parts) } : item)));
  }

  @Post(':id/claim')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_CLAIM)
  async claim(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.claim(actor, id);
  }

  @Post(':id/accept')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_CLAIM)
  async accept(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.control.accept(actor, id);
  }

  @Post(':id/decline')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_CLAIM)
  async decline(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.control.decline(actor, id);
  }

  @Post(':id/take-over')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_TAKE_OVER)
  async takeOver(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.takeOver(actor, id);
  }

  @Post(':id/transfer')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_TRANSFER)
  async transfer(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: TransferInput }) body: Transfer) {
    await this.access.assert(actor.principal!, id);
    await this.control.transfer(actor, id, body);
  }

  @Post(':id/return-to-ai')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_RETURN_TO_AI)
  async returnToAi(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ReturnToAiInput }) body: ReturnToAi) {
    await this.access.assert(actor.principal!, id);
    await this.control.returnToAi(actor, id, body);
  }

  @Post(':id/cancel-return')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_RETURN_TO_AI)
  async cancelReturn(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.cancelReturn(actor, id);
  }

  @Post(':id/resolve')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_RESOLVE)
  async resolve(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ResolveInput }) body: Resolve) {
    await this.access.assert(actor.principal!, id);
    await this.control.resolve(actor, id, body);
  }

  @Post(':id/reopen')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_TAKE_OVER)
  async reopen(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.reopen(actor, id);
  }

  @Post(':id/notes')
  @RequirePermission(Permission.CONVERSATIONS_NOTE)
  async note(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: NoteInput }) body: NoteInput) {
    await this.access.assert(actor.principal!, id);
    return addNote(this.db, actor, id, body);
  }

  /** Replace the tag set (normalized, de-duplicated, ≤ 20); returns what was stored. */
  @Put(':id/tags')
  @RequirePermission(Permission.CONVERSATIONS_NOTE)
  async setTags(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: SetTagsInput }) body: SetTagsInput) {
    await this.access.assert(actor.principal!, id);
    return setConversationTags(this.db, actor, id, body);
  }

  @Post(':id/messages')
  @RequirePermission(Permission.CONVERSATIONS_REPLY)
  async reply(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: HumanReplyInput }) body: HumanReplyInput) {
    await this.access.assert(actor.principal!, id);
    return sendHumanReply(this.db, this.queue, actor, id, body, { media: this.blobs });
  }
}
