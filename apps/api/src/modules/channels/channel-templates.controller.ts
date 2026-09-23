import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, sql } from 'drizzle-orm';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, MessageTemplateService, TEMPLATE_KIND, WithApproval, manageableChannelsSql, requestApproval, submitOrDiscard, type ActorContext } from '@ocso/application';
import type { ChannelRegistry } from '@ocso/channels';
import { channels, type Db } from '@ocso/db';
import { TemplateDraftSchema, type TemplateDraft } from '@ocso/domain';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';
import { approvalResponse } from '../approvals/approval-response.js';

const Id = z.uuid();
const TemplateId = z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'invalid template id');
const ListQuery = z.object({ refresh: z.enum(['true', 'false']).optional() });
type ListQuery = z.infer<typeof ListQuery>;
const DraftBody = TemplateDraftSchema.extend(WithApproval.shape);
type DraftBody = z.input<typeof DraftBody>;
type ApprovalBody = z.infer<typeof WithApproval>;

/**
 * Message templates of a channel (docs/07 §3), for kinds whose adapter
 * implements them. Reading is for anyone who replies to customers (the
 * workspace picker) or manages templates; creating (= submitting for the
 * provider's review) and deleting need `message_templates.manage` and a
 * channel the caller's teams use.
 */
@Controller('v1/channels/:id/templates')
export class ChannelTemplatesController {
  constructor(
    @Inject(MessageTemplateService) private readonly templates: MessageTemplateService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  /** Provider list (cached ~5 min; `?refresh=true` refetches) merged with templates submitted from OCSO. */
  @Capability({ name: 'channels.list_message_templates', summary: "List a channel's message templates with their review status.", tags: ['template', 'message template'] })
  @Get()
  @RequireAnyPermission(Permission.CONVERSATIONS_REPLY, Permission.MESSAGE_TEMPLATES_MANAGE)
  list(@Param('id', { schema: Id }) id: string, @Query({ schema: ListQuery }) q: ListQuery) {
    return this.templates.list(id, { refresh: q.refresh === 'true' });
  }

  /** Current review status (incl. the rejection reason), asked from the provider. */
  @Capability({ name: 'channels.get_message_template', summary: 'Get one message template and its review status.', tags: ['template'] })
  @Get(':templateId')
  @RequireAnyPermission(Permission.CONVERSATIONS_REPLY, Permission.MESSAGE_TEMPLATES_MANAGE)
  get(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Param('templateId', { schema: TemplateId }) templateId: string) {
    return this.templates.get(actor, id, templateId);
  }

  /**
   * Save a draft (201): the provider never sees it until a checker approves its submission. With `approval`,
   * the submission is proposed in the same call (202 `{ template, problems, warnings, proposal }`).
   */
  @Capability({ name: 'channels.create_message_template', summary: 'Save a new message template draft for a channel.', tags: ['template'] })
  @Post()
  @RequirePermission(Permission.MESSAGE_TEMPLATES_MANAGE)
  async create(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: DraftBody }) body: DraftBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...draft } = body;
    const created = await this.templates.createDraft(actor, id, draft);
    const recordId = created.template.submission!.recordId;
    if (!approval) return { ...created, approvalRequired: { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'CREATE' } };
    // A submission that fails (a problem in the draft, no eligible checker) fails the whole request: the draft goes too,
    // so a retry is not refused as template_exists.
    const outcome = await submitOrDiscard(
      () => requestApproval(this.approvals, actor, { objectKind: TEMPLATE_KIND, objectId: recordId, action: 'CREATE' }, approval, null),
      () => this.templates.discardFailedCreate(actor, id, recordId),
    );
    res.status(202);
    return { ...created, proposal: outcome.kind === 'proposed' ? outcome.proposal : null };
  }

  /** Edit a draft the provider has never seen (409 template_submitted once it is at the provider; approval_open while its submission waits). */
  @Capability({ name: 'channels.update_message_template_draft', summary: 'Edit a message template draft that was never submitted.', tags: ['template'] })
  @Put('drafts/:recordId')
  @RequirePermission(Permission.MESSAGE_TEMPLATES_MANAGE)
  updateDraft(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Param('recordId', { schema: Id }) recordId: string, @Body({ schema: TemplateDraftSchema }) body: TemplateDraft) {
    return this.templates.updateDraft(actor, id, recordId, body);
  }

  /** Submit a draft to the provider: always a proposal — 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Capability({ name: 'channels.submit_message_template', summary: 'Submit a message template draft to the provider (always needs approval).', tags: ['template'] })
  @Post('drafts/:recordId/submit')
  @RequirePermission(Permission.MESSAGE_TEMPLATES_MANAGE)
  async submit(
    @Actor() actor: ActorContext,
    @Param('id', { schema: Id }) id: string,
    @Param('recordId', { schema: Id }) recordId: string,
    @Body({ schema: WithApproval.optional() }) body: ApprovalBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const objectId = await this.templates.draftId(actor, id, recordId);
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: TEMPLATE_KIND, objectId, action: 'CREATE' }, body?.approval, null));
  }

  /**
   * Deleting (message_templates.delete, Head) is always a proposal: 202 `{proposal}` with `approval`, else 409
   * approval_required. A template made in the provider's console is recorded first so the proposal has an object.
   */
  @Capability({ name: 'channels.delete_message_template', summary: 'Delete a message template (always needs approval).', tags: ['template'] })
  @Delete(':templateId')
  @RequirePermission(Permission.MESSAGE_TEMPLATES_DELETE)
  async remove(
    @Actor() actor: ActorContext,
    @Param('id', { schema: Id }) id: string,
    @Param('templateId', { schema: TemplateId }) templateId: string,
    @Body({ schema: WithApproval.optional() }) body: ApprovalBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const objectId = await this.templates.deletionTarget(actor, id, templateId);
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: TEMPLATE_KIND, objectId, action: 'DELETE' }, body?.approval, null));
  }
}

/** Channels whose templates the caller may manage (the templates page's channel picker), with each kind's template wording. */
@Controller('v1/message-templates')
export class MessageTemplateChannelsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
  ) {}

  @Capability({ name: 'channels.list_template_channels', summary: 'List the channels whose message templates you can manage.', tags: ['template'] })
  @Get('channels')
  @RequirePermission(Permission.MESSAGE_TEMPLATES_MANAGE)
  async channels(@CurrentPrincipal() principal: Principal) {
    const kinds = this.registry.describeAll().filter((k) => k.messageTemplates);
    if (!kinds.length) return [];
    const scope = manageableChannelsSql(principal);
    const rows = await this.db
      .select({ id: channels.id, kind: channels.kind, name: channels.name, status: channels.status })
      .from(channels)
      .where(and(sql`${channels.kind} IN (${sql.join(kinds.map((k) => sql`${k.kind}`), sql`, `)})`, scope ?? undefined))
      .orderBy(asc(channels.name));
    const byKind = new Map(kinds.map((k) => [k.kind, k]));
    return rows.map((row) => ({ ...row, kindLabel: byKind.get(row.kind)?.label ?? row.kind, templates: byKind.get(row.kind)?.templates ?? null }));
  }
}
