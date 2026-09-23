import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import {
  TemplateDraftSchema,
  checkTemplateDraft,
  conflict,
  isDomainError,
  notFound,
  validation,
  type DraftIssue,
  type MessageTemplate,
  type TemplateDraft,
} from '@ocso/domain';
import { uuidv7, messageTemplates, type Db } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { systemActor, type ActorContext } from '../shared/context.js';
import { loadChannel, loadManageableChannel, type ChannelRow } from './message-templates-access.js';
import { applyTemplateStatus } from './message-templates-status.js';
import { mergeTemplates, submittedRows, type TemplateListView, type TemplateView } from './message-templates-view.js';

/** What the service needs from the channel's adapter (bound to its config by agent-runtime). */
export interface TemplateProviderPort {
  listTemplates?: (() => Promise<MessageTemplate[]>) | undefined;
  createTemplate?: ((draft: TemplateDraft) => Promise<MessageTemplate>) | undefined;
  templateStatus?: ((templateId: string) => Promise<MessageTemplate | null>) | undefined;
  deleteTemplate?: ((template: { id: string; name: string }) => Promise<void>) | undefined;
}
export type TemplateProviderSource = (channelId: string) => Promise<TemplateProviderPort>;

export const TEMPLATE_CACHE_TTL_MS = 5 * 60_000;
/** `config.changed` area announced when a channel's templates change (template lists refresh). */
export const TEMPLATES_CONFIG_AREA = 'message_templates';

/**
 * Message templates of a channel (docs/07 §3), for any kind whose adapter
 * implements the template methods: the provider's list (cached ~5 minutes per
 * API instance, `refresh` bypasses it) merged with the templates submitted
 * from OCSO; create + submit for review, status and delete for CS Leads
 * (their teams' channels) and Tech Admins.
 */
export class MessageTemplateService {
  private readonly cache = new Map<string, { at: Date; templates: MessageTemplate[] }>();

  constructor(
    private readonly db: Db,
    private readonly providers: TemplateProviderSource,
    private readonly options: { ttlMs?: number; now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Callers hold conversations.reply or message_templates.manage (checked by the route). */
  async list(channelId: string, options: { refresh?: boolean } = {}): Promise<TemplateListView> {
    const channel = await loadChannel(this.db, channelId);
    const port = await this.port(channel);
    const list = port.listTemplates;
    if (!list) throw validation('templates_unsupported', `${channel.name} has no message templates`);
    let cached = this.cache.get(channelId);
    let problem: TemplateListView['problem'] = null;
    const fresh = cached && this.now().getTime() - cached.at.getTime() < (this.options.ttlMs ?? TEMPLATE_CACHE_TTL_MS);
    if (!fresh || options.refresh) {
      try {
        cached = { at: this.now(), templates: await list() };
        this.cache.set(channelId, cached);
      } catch (error) {
        if (!isDomainError(error)) throw error;
        problem = { code: error.code, message: error.message };
      }
    }
    const [rows, deleted] = await Promise.all([submittedRows(this.db, channelId), this.deletedIds(channelId)]);
    const provider = (cached?.templates ?? []).filter((t) => !deleted.has(t.id));
    return {
      channel: { id: channel.id, kind: channel.kind, name: channel.name },
      templates: mergeTemplates(provider, rows, cached?.at ?? null),
      fetchedAt: cached?.at.toISOString() ?? null,
      problem,
    };
  }

  /** One template for sending: from the cached list, refreshed once when unknown. */
  async find(channelId: string, templateId: string): Promise<TemplateView | null> {
    const first = await this.list(channelId);
    const hit = first.templates.find((t) => t.id === templateId);
    if (hit || first.problem) return hit ?? null;
    return (await this.list(channelId, { refresh: true })).templates.find((t) => t.id === templateId) ?? null;
  }

  /** Current review state, asked from the provider (and recorded when it changed). */
  async get(actor: ActorContext, channelId: string, templateId: string): Promise<TemplateView> {
    const channel = await loadChannel(this.db, channelId);
    const port = await this.port(channel);
    const [row] = await submittedRows(this.db, channelId, [templateId]);
    const current = port.templateStatus ? await port.templateStatus(templateId) : ((await this.find(channelId, templateId)) ?? null);
    if (!current && !row) throw notFound('template', templateId);
    // A provider decision observed on request: recorded (and announced) as a system change, not as the viewer's.
    const observer = systemActor('template-status-check', actor.correlationId, 'Template status check');
    if (row && current) await applyTemplateStatus(this.db, observer, row, { status: current.status, reason: current.rejectionReason, category: current.category }, this.now());
    const after = row ? await submittedRows(this.db, channelId, [templateId]) : [];
    // Not at the provider (any more): show what was submitted from OCSO.
    return mergeTemplates(current ? [current] : [], after, this.now())[0]!;
  }

  async create(actor: ActorContext, channelId: string, input: unknown): Promise<{ template: TemplateView; warnings: DraftIssue[] }> {
    const principal = actor.principal as Principal;
    const channel = await loadManageableChannel(this.db, principal, channelId);
    const draft = TemplateDraftSchema.parse(input);
    const check = checkTemplateDraft(draft);
    if (check.problems.length) {
      throw validation('invalid_template', check.problems.map((p) => p.message).join('; '), { problems: check.problems, warnings: check.warnings });
    }
    const port = await this.port(channel);
    if (!port.createTemplate) throw validation('templates_unsupported', `${channel.name} cannot create message templates`);
    const [dup] = await this.db
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.channelId, channelId), eq(messageTemplates.name, draft.name), eq(messageTemplates.language, draft.language), isNull(messageTemplates.deletedAt)));
    if (dup) throw conflict('template_exists', `${draft.name} (${draft.language}) was already submitted from OCSO`);
    const created = await port.createTemplate(draft);
    const now = this.now();
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(messageTemplates).values({
        id,
        channelId,
        providerTemplateId: created.id,
        name: draft.name,
        language: draft.language,
        category: created.category ?? draft.category,
        status: created.status,
        rejectionReason: created.rejectionReason,
        definition: { ...draft, placeholderScope: created.placeholderScope } as unknown as Record<string, unknown>,
        submittedBy: principal.userId,
        submittedAt: now,
        statusCheckedAt: now,
        statusChangedAt: now,
      });
      const target = { targetType: 'message_template', targetId: id };
      await recordAudit(tx, actor, { action: 'message_template.create', ...target, summary: `Created message template ${draft.name} (${draft.language}) on ${channel.name}`, after: { providerTemplateId: created.id, ...draft } });
      await recordAudit(tx, actor, { action: 'message_template.submit', ...target, summary: `Submitted ${draft.name} (${draft.language}) for review as ${draft.category}`, after: { status: created.status } });
      await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: channelId });
    });
    this.cache.delete(channelId);
    const [row] = await submittedRows(this.db, channelId, [created.id]);
    return { template: mergeTemplates([created], row ? [row] : [], now)[0]!, warnings: check.warnings };
  }

  async remove(actor: ActorContext, channelId: string, templateId: string): Promise<void> {
    const channel = await loadManageableChannel(this.db, actor.principal as Principal, channelId);
    const port = await this.port(channel);
    if (!port.deleteTemplate) throw validation('templates_unsupported', `${channel.name} cannot delete message templates`);
    const [row] = await submittedRows(this.db, channelId, [templateId]);
    const template = row ? { id: row.providerTemplateId, name: row.name } : await this.find(channelId, templateId);
    if (!template) throw notFound('template', templateId);
    await port.deleteTemplate({ id: template.id, name: template.name });
    await this.db.transaction(async (tx) => {
      if (row) await tx.update(messageTemplates).set({ deletedAt: this.now(), updatedAt: this.now() }).where(eq(messageTemplates.id, row.id));
      await recordAudit(tx, actor, {
        action: 'message_template.delete',
        targetType: 'message_template',
        targetId: row?.id ?? template.id,
        summary: `Deleted message template ${template.name} from ${channel.name}`,
        before: { providerTemplateId: template.id, name: template.name },
      });
      await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: channelId });
    });
    this.cache.delete(channelId);
  }

  /** Forget the cached provider list (e.g. after a provider status webhook). */
  invalidate(channelId: string): void {
    this.cache.delete(channelId);
  }

  private port(channel: ChannelRow): Promise<TemplateProviderPort> {
    return this.providers(channel.id);
  }

  private async deletedIds(channelId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: messageTemplates.providerTemplateId })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.channelId, channelId), isNotNull(messageTemplates.deletedAt)));
    return new Set(rows.map((r) => r.id));
  }
}
