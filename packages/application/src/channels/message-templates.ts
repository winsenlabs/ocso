import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { isDomainError, notFound, validation, type DraftIssue, type MessageTemplate, type TemplateDraft } from '@ocso/domain';
import { messageTemplates, type Db } from '@ocso/db';
import { systemActor, type ActorContext } from '../shared/context.js';
import { discardUnsubmittedDraft } from '../approvals/unsubmitted-draft.js';
import { TEMPLATE_KIND, createTemplateDraft, deletionTarget, templateApprovals, templateRowOf, updateTemplateDraft } from './message-template-drafts.js';
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
export { TEMPLATES_CONFIG_AREA } from './message-template-drafts.js';

/**
 * Message templates of a channel (docs/07 §3), for any kind whose adapter
 * implements the template methods: the provider's list (cached ~5 minutes per
 * API instance, `refresh` bypasses it) merged with OCSO's drafts and
 * submissions. Drafts are written here; submitting one to the provider and
 * deleting a template are approved proposals (message-template-approval.ts),
 * finished by the worker (message-template-provider.ts).
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
      templates: mergeTemplates(provider, rows, cached?.at ?? null, await templateApprovals(this.db, rows.map((r) => r.id))),
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
    if (row && !row.providerTemplateId) return this.viewOf(channelId, row.id);
    const current = port.templateStatus ? await port.templateStatus(templateId) : ((await this.find(channelId, templateId)) ?? null);
    if (!current && !row) throw notFound('template', templateId);
    // A provider decision observed on request: recorded (and announced) as a system change, not as the viewer's.
    const observer = systemActor('template-status-check', actor.correlationId, 'Template status check');
    if (row && current) await applyTemplateStatus(this.db, observer, row, { status: current.status, reason: current.rejectionReason, category: current.category }, this.now());
    const after = row ? await submittedRows(this.db, channelId, [templateId]) : [];
    // Not at the provider (any more): show what was submitted from OCSO.
    return mergeTemplates(current ? [current] : [], after, this.now(), await templateApprovals(this.db, after.map((r) => r.id)))[0]!;
  }

  /**
   * Save a draft (never sent here): the provider sees it only when a `message_template` CREATE proposal is
   * approved (PM/research/11 §4). `problems` block that submission until fixed; `warnings` are advisory.
   */
  async createDraft(actor: ActorContext, channelId: string, input: unknown): Promise<{ template: TemplateView; problems: DraftIssue[]; warnings: DraftIssue[] }> {
    const channel = await loadManageableChannel(this.db, actor.principal as Principal, channelId);
    const port = await this.port(channel);
    if (!port.createTemplate) throw validation('templates_unsupported', `${channel.name} cannot create message templates`);
    const { row, problems, warnings } = await createTemplateDraft(this.db, actor, channel, input);
    return { template: await this.viewOf(channelId, row.id), problems, warnings };
  }

  /** Edit a draft the provider has never seen (409 approval_open while its submission waits for a checker). */
  async updateDraft(actor: ActorContext, channelId: string, recordId: string, input: unknown): Promise<{ template: TemplateView; problems: DraftIssue[]; warnings: DraftIssue[] }> {
    const channel = await loadManageableChannel(this.db, actor.principal as Principal, channelId);
    const { row, problems, warnings } = await updateTemplateDraft(this.db, actor, channel, recordId, input);
    return { template: await this.viewOf(channelId, row.id), problems, warnings };
  }

  /** Undo a draft this request saved when its submission could not be made (never once anything was proposed; frees the name). */
  async discardFailedCreate(actor: ActorContext, channelId: string, recordId: string): Promise<void> {
    const row = await templateRowOf(this.db, channelId, recordId);
    if (!row || row.id !== recordId || row.providerTemplateId) return;
    await discardUnsubmittedDraft(this.db, actor, {
      kind: TEMPLATE_KIND,
      id: recordId,
      name: `${row.name} (${row.language})`,
      remove: async (tx) => void (await tx.delete(messageTemplates).where(and(eq(messageTemplates.id, recordId), isNull(messageTemplates.providerTemplateId)))),
    });
  }

  /** The OCSO record id of a draft of this channel the caller may submit (404 otherwise). */
  async draftId(actor: ActorContext, channelId: string, recordId: string): Promise<string> {
    const channel = await loadManageableChannel(this.db, actor.principal as Principal, channelId);
    const row = await templateRowOf(this.db, channel.id, recordId);
    if (!row || row.id !== recordId) throw notFound('template', recordId);
    return row.id;
  }

  /**
   * The OCSO record a deletion proposal points at (provider id or record id). A template made in the
   * provider's console is recorded first (origin PROVIDER) so the proposal has an object.
   */
  async deletionTarget(actor: ActorContext, channelId: string, templateId: string): Promise<string> {
    const row = await deletionTarget(this.db, actor.principal as Principal, channelId, templateId, () => this.find(channelId, templateId));
    this.cache.delete(channelId);
    return row.id;
  }

  private async viewOf(channelId: string, recordId: string): Promise<TemplateView> {
    const rows = (await submittedRows(this.db, channelId)).filter((r) => r.id === recordId);
    return mergeTemplates([], rows, this.now(), await templateApprovals(this.db, rows.map((r) => r.id)))[0]!;
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
      .where(and(eq(messageTemplates.channelId, channelId), isNotNull(messageTemplates.deletedAt), isNotNull(messageTemplates.providerTemplateId)));
    return new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  }
}
