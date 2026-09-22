import { draftAsTemplate, type MessageTemplate, type TemplateDraft } from '@ocso/domain';
import { z } from 'zod';
import { safeProviderText } from '../../common/redact.js';
import { TemplateProviderError, normalizeTemplateCategory, templateReasonForStatus } from '../../common/templates.js';
import { secretValues, type ResolvedWhatsAppConfig } from '../config.js';
import type { GraphClient, GraphResult } from '../graph-client.js';
import { createTemplateBody } from './components.js';
import { MetaTemplate, metaTemplateStatus, normalizeMetaTemplate } from './normalize.js';

/**
 * WhatsApp templates on the Cloud API (PM/research/10 §6–§7): the WhatsApp
 * Business Account (WABA) id from the channel settings is required to list,
 * create and delete; the access token needs whatsapp_business_management.
 */

export const TEMPLATE_FIELDS = 'id,name,language,status,category,components,parameter_format,rejected_reason';
const MAX_PAGES = 20;

const Page = z.looseObject({ data: z.array(z.unknown()).default([]), paging: z.looseObject({ next: z.string().nullish() }).nullish() });
const Created = z.looseObject({ id: z.union([z.string(), z.number()]).transform(String), status: z.string().nullish(), category: z.string().nullish() });

export class MetaTemplates {
  constructor(
    private readonly config: ResolvedWhatsAppConfig,
    private readonly graph: GraphClient,
  ) {}

  private waba(): string {
    const id = this.config.settings.businessAccountId;
    if (!id) {
      throw new TemplateProviderError(
        'not_configured',
        'Add the WhatsApp Business Account id (WABA id) to this channel’s settings to use message templates',
      );
    }
    return id;
  }

  private fail(result: Exclude<GraphResult, { kind: 'ok' }>, what: string): TemplateProviderError {
    if (result.kind === 'network') return new TemplateProviderError('unavailable', result.timedOut ? `Meta did not answer in time (${what})` : `Meta could not be reached (${what})`);
    const text = safeProviderText([result.error.message, result.error.details].filter(Boolean).join(' — '), secretValues(this.config), 300);
    const code = result.error.code;
    const auth = code === 190 || code === 0 || code === 10 || (code !== undefined && code >= 200 && code <= 299);
    const reason = auth ? 'auth_failed' : code === 4 || code === 80008 ? 'rate_limited' : templateReasonForStatus(result.status);
    const lead = reason === 'auth_failed' ? 'Meta rejected the channel’s access token for templates (it needs whatsapp_business_management)' : `Meta refused ${what}`;
    return new TemplateProviderError(reason, `${lead} (HTTP ${result.status}${code !== undefined ? `, error ${code}` : ''})${text ? `: ${text}` : ''}`);
  }

  async list(): Promise<MessageTemplate[]> {
    const out: MessageTemplate[] = [];
    let result = await this.graph.getWithQuery([this.waba(), 'message_templates'], { fields: TEMPLATE_FIELDS, limit: '100' });
    for (let page = 0; page < MAX_PAGES; page++) {
      if (result.kind !== 'ok') throw this.fail(result, 'the template list');
      const parsed = Page.safeParse(result.body);
      if (!parsed.success) throw new TemplateProviderError('unavailable', 'Meta answered the template list with an unexpected shape');
      for (const raw of parsed.data.data) {
        const item = MetaTemplate.safeParse(raw);
        const template = item.success ? normalizeMetaTemplate(item.data) : null;
        if (template) out.push(template);
      }
      const next = parsed.data.paging?.next;
      if (!next) break;
      result = await this.graph.getPage(next);
    }
    return out;
  }

  /** One template by id; null when Meta no longer has it (404, or error 100 for an unknown object). */
  async status(templateId: string): Promise<MessageTemplate | null> {
    if (!/^\d{1,32}$/.test(templateId)) return null;
    const result = await this.graph.getWithQuery([templateId], { fields: TEMPLATE_FIELDS });
    if (result.kind !== 'ok') {
      if (result.kind === 'error' && (result.status === 404 || result.error.code === 100 || result.error.code === 803)) return null;
      throw this.fail(result, 'the template');
    }
    const item = MetaTemplate.safeParse(result.body);
    if (!item.success) throw new TemplateProviderError('unavailable', 'Meta answered the template with an unexpected shape');
    return normalizeMetaTemplate(item.data);
  }

  /** Create = submit: Meta reviews every new template (usually minutes, up to 24 hours). */
  async create(draft: TemplateDraft): Promise<MessageTemplate> {
    const waba = this.waba();
    const result = await this.graph.postJson([waba, 'message_templates'], createTemplateBody(draft));
    if (result.kind !== 'ok') throw this.fail(result, 'the new template');
    const created = Created.safeParse(result.body);
    if (!created.success) throw new TemplateProviderError('unavailable', 'Meta created the template without an id');
    const template = draftAsTemplate(draft, { id: created.data.id, status: metaTemplateStatus(created.data.status) ?? 'PENDING', scope: 'component' });
    return { ...template, category: normalizeTemplateCategory(created.data.category) ?? draft.category };
  }

  /** Delete this template only (by id and name — name alone would delete every language). */
  async remove(template: { id: string; name: string }): Promise<void> {
    const result = await this.graph.deleteWithQuery([this.waba(), 'message_templates'], { hsm_id: template.id, name: template.name });
    if (result.kind !== 'ok' && !(result.kind === 'error' && result.status === 404)) throw this.fail(result, 'deleting the template');
  }
}
