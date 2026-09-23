import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { and, asc, sql } from 'drizzle-orm';
import { Permission, type Principal } from '@ocso/auth';
import { MessageTemplateService, manageableChannelsSql, type ActorContext } from '@ocso/application';
import type { ChannelRegistry } from '@ocso/channels';
import { channels, type Db } from '@ocso/db';
import { TemplateDraftSchema, type TemplateDraft } from '@ocso/domain';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';

const Id = z.uuid();
const TemplateId = z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'invalid template id');
const ListQuery = z.object({ refresh: z.enum(['true', 'false']).optional() });
type ListQuery = z.infer<typeof ListQuery>;

/**
 * Message templates of a channel (docs/07 §3), for kinds whose adapter
 * implements them. Reading is for anyone who replies to customers (the
 * workspace picker) or manages templates; creating (= submitting for the
 * provider's review) and deleting need `message_templates.manage` and a
 * channel the caller's teams use.
 */
@Controller('v1/channels/:id/templates')
export class ChannelTemplatesController {
  constructor(@Inject(MessageTemplateService) private readonly templates: MessageTemplateService) {}

  /** Provider list (cached ~5 min; `?refresh=true` refetches) merged with templates submitted from OCSO. */
  @Get()
  @RequireAnyPermission(Permission.CONVERSATIONS_REPLY, Permission.MESSAGE_TEMPLATES_MANAGE)
  list(@Param('id', { schema: Id }) id: string, @Query({ schema: ListQuery }) q: ListQuery) {
    return this.templates.list(id, { refresh: q.refresh === 'true' });
  }

  /** Current review status (incl. the rejection reason), asked from the provider. */
  @Get(':templateId')
  @RequireAnyPermission(Permission.CONVERSATIONS_REPLY, Permission.MESSAGE_TEMPLATES_MANAGE)
  get(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Param('templateId', { schema: TemplateId }) templateId: string) {
    return this.templates.get(actor, id, templateId);
  }

  /** Create at the provider and submit for review; returns the template (PENDING) and advisory warnings. */
  @Post()
  @RequirePermission(Permission.MESSAGE_TEMPLATES_MANAGE)
  create(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: TemplateDraftSchema }) body: TemplateDraft) {
    return this.templates.create(actor, id, body);
  }

  @Delete(':templateId')
  @HttpCode(204)
  @RequirePermission(Permission.MESSAGE_TEMPLATES_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Param('templateId', { schema: TemplateId }) templateId: string) {
    await this.templates.remove(actor, id, templateId);
  }
}

/** Channels whose templates the caller may manage (the templates page's channel picker), with each kind's template wording. */
@Controller('v1/message-templates')
export class MessageTemplateChannelsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
  ) {}

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
