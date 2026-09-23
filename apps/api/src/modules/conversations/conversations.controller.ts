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
  TemplateMessageInput,
  TransferInput,
  MessageTemplateService,
  addNote,
  loadConversationDetail,
  loadTimeline,
  sendHumanReply,
  sendTemplateMessage,
  setConversationTags,
  tagSuggestions,
  type ActorContext,
  type SessionWindowHours,
} from '@ocso/application';
import { notFound } from '@ocso/domain';
import type { Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import type { BlobStore } from '@ocso/blob';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { BLOB_STORE, DB, QUEUE } from '../../infrastructure/tokens.js';
import { SESSION_WINDOW_HOURS } from '../channels/templates.providers.js';
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
    @Inject(MessageTemplateService) private readonly templates: MessageTemplateService,
    @Inject(SESSION_WINDOW_HOURS) private readonly windowHours: SessionWindowHours,
  ) {}

  @Capability({ name: 'conversations.list_conversations', summary: 'List conversations you can see (all, mine, waiting, AI, human, priority, resolved), with search.', tags: ['inbox', 'waiting'] })
  @Get()
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async list(@CurrentPrincipal() principal: Principal, @Query({ schema: InboxQuery }) q: InboxQuery) {
    return this.inbox.list(principal, await this.access.policy(), q);
  }

  /** Most used tags on conversations the caller can see (autocomplete). Declared before `:id`. */
  @Capability({ name: 'conversations.list_conversation_tags', summary: 'The most used conversation tags (autocomplete by prefix).', tags: ['tag', 'label'] })
  @Get('tags')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async tags(@CurrentPrincipal() principal: Principal, @Query({ schema: TagSuggestionQuery }) q: TagSuggestionQuery) {
    return tagSuggestions(this.db, principal, await this.access.policy(), q);
  }

  @Capability({ name: 'conversations.get_conversation', summary: 'Get one conversation: customer, agent, state, queue, assignee and summary.' })
  @Get(':id')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async detail(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(principal, id);
    const detail = await loadConversationDetail(this.db, id, { windowHours: this.windowHours });
    if (!detail) throw notFound('conversation', id);
    return detail;
  }

  @Capability({ name: 'conversations.get_conversation_timeline', summary: "Read a conversation's messages and events in order.", tags: ['messages', 'transcript', 'history'] })
  @Get(':id/timeline')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async timeline(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Query({ schema: TimelineQuery }) q: TimelineQuery) {
    await this.access.assert(principal, id);
    const items = await loadTimeline(this.db, id, { afterSeq: q.afterSeq });
    return Promise.all(items.map(async (item) => (item.kind === 'message' ? { ...item, parts: await this.access.signParts(item.parts) } : item)));
  }

  @Capability({ name: 'conversations.claim_conversation', summary: 'Claim a waiting conversation for yourself.', risk: 'LOW_WRITE', tags: ['pick up', 'assign to me'] })
  @Post(':id/claim')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_CLAIM)
  async claim(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.claim(actor, id);
  }

  @Capability({ name: 'conversations.accept_conversation', summary: 'Accept a conversation offered to you.', risk: 'LOW_WRITE', tags: ['offer'] })
  @Post(':id/accept')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_CLAIM)
  async accept(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.control.accept(actor, id);
  }

  @Capability({ name: 'conversations.decline_conversation', summary: 'Decline a conversation offered to you.', risk: 'LOW_WRITE', tags: ['offer'] })
  @Post(':id/decline')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_CLAIM)
  async decline(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.control.decline(actor, id);
  }

  @Capability({ name: 'conversations.take_over_conversation', summary: 'Take over a conversation from the AI agent.', tags: ['handover', 'human', 'escalate'] })
  @Post(':id/take-over')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_TAKE_OVER)
  async takeOver(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.takeOver(actor, id);
  }

  @Capability({ name: 'conversations.transfer_conversation', summary: 'Transfer a conversation to another queue or person.', tags: ['reassign', 'move', 'handover'] })
  @Post(':id/transfer')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_TRANSFER)
  async transfer(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: TransferInput }) body: Transfer) {
    await this.access.assert(actor.principal!, id);
    await this.control.transfer(actor, id, body);
  }

  @Capability({ name: 'conversations.return_to_ai', summary: 'Hand a conversation back to the AI agent, with a handover summary.', tags: ['handback', 'ai'] })
  @Post(':id/return-to-ai')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_RETURN_TO_AI)
  async returnToAi(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ReturnToAiInput }) body: ReturnToAi) {
    await this.access.assert(actor.principal!, id);
    await this.control.returnToAi(actor, id, body);
  }

  @Capability({ name: 'conversations.cancel_return_to_ai', summary: 'Cancel a pending hand-back to the AI agent.', risk: 'LOW_WRITE', tags: ['handback'] })
  @Post(':id/cancel-return')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_RETURN_TO_AI)
  async cancelReturn(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.cancelReturn(actor, id);
  }

  @Capability({ name: 'conversations.resolve_conversation', summary: 'Resolve a conversation, with a disposition and tags.', tags: ['close', 'done'] })
  @Post(':id/resolve')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_RESOLVE)
  async resolve(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: ResolveInput }) body: Resolve) {
    await this.access.assert(actor.principal!, id);
    await this.control.resolve(actor, id, body);
  }

  @Capability({ name: 'conversations.reopen_conversation', summary: 'Reopen a resolved conversation.' })
  @Post(':id/reopen')
  @HttpCode(204)
  @RequirePermission(Permission.CONVERSATIONS_TAKE_OVER)
  async reopen(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(actor.principal!, id);
    await this.control.reopen(actor, id);
  }

  @Capability({ name: 'conversations.add_note', summary: 'Add an internal note to a conversation (optionally shown to the AI agent).', risk: 'LOW_WRITE', tags: ['note', 'comment', 'internal'] })
  @Post(':id/notes')
  @RequirePermission(Permission.CONVERSATIONS_NOTE)
  async note(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: NoteInput }) body: NoteInput) {
    await this.access.assert(actor.principal!, id);
    return addNote(this.db, actor, id, body);
  }

  /** Replace the tag set (normalized, de-duplicated, ≤ 20); returns what was stored. */
  @Capability({ name: 'conversations.set_tags', summary: "Replace a conversation's tags.", risk: 'LOW_WRITE', tags: ['tag', 'label'] })
  @Put(':id/tags')
  @RequirePermission(Permission.CONVERSATIONS_NOTE)
  async setTags(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: SetTagsInput }) body: SetTagsInput) {
    await this.access.assert(actor.principal!, id);
    return setConversationTags(this.db, actor, id, body);
  }

  @Capability({ name: 'conversations.send_reply', summary: 'Send a reply to the customer in a conversation.', tags: ['reply', 'message', 'respond'] })
  @Post(':id/messages')
  @RequirePermission(Permission.CONVERSATIONS_REPLY)
  async reply(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: HumanReplyInput }) body: HumanReplyInput) {
    await this.access.assert(actor.principal!, id);
    return sendHumanReply(this.db, this.queue, actor, id, body, { media: this.blobs, windowHours: this.windowHours });
  }

  /**
   * Send an approved WhatsApp template (the only way to reach the customer
   * after the 24-hour window; allowed inside it too). `reopen: true` reopens a
   * resolved conversation and sends in one step.
   */
  @Capability({ name: 'conversations.send_template_message', summary: 'Send an approved message template to the customer (e.g. outside the messaging window).', tags: ['template', 'message'] })
  @Post(':id/template-message')
  @RequirePermission(Permission.CONVERSATIONS_REPLY)
  async templateMessage(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: TemplateMessageInput }) body: TemplateMessageInput) {
    await this.access.assert(actor.principal!, id);
    return sendTemplateMessage(this.db, this.queue, actor, id, body, { templates: this.templates });
  }
}
