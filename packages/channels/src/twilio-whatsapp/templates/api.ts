import type { MessageTemplate, TemplateDraft } from '@ocso/domain';
import { z } from 'zod';
import { safeProviderText } from '../../common/redact.js';
import { TemplateProviderError, templateReasonForStatus } from '../../common/templates.js';
import { twilioSecretValues, type ResolvedTwilioConfig } from '../config.js';
import { TwilioRestClient, type TwilioResult } from '../rest-client.js';
import { approvalRequestBody, contentCreateBody } from './draft.js';
import { ContentItem, normalizeContentItem, whatsappApproval } from './normalize.js';
import type { ChannelFetch } from '../../contract/types.js';

/**
 * WhatsApp templates through Twilio's Content API (content.twilio.com,
 * PM/research/10 §1–§5): list with approval state, status of one, create +
 * submit for WhatsApp approval, delete. Same credentials as sending.
 */

const MAX_PAGES = 20;
const PAGE_SIZE = 500;

const ListPage = z.looseObject({
  contents: z.array(z.unknown()).default([]),
  meta: z.looseObject({ next_page_url: z.string().nullish() }).optional(),
});

export class TwilioTemplates {
  private readonly client: TwilioRestClient;
  private readonly base: string;

  constructor(
    private readonly config: ResolvedTwilioConfig,
    fetchImpl: ChannelFetch,
  ) {
    this.client = new TwilioRestClient(config, fetchImpl);
    this.base = config.settings.contentApiBaseUrl;
  }

  private url(...segments: string[]): string {
    return `${this.base}/v1/${segments.map(encodeURIComponent).join('/')}`;
  }

  private fail(result: Exclude<TwilioResult, { kind: 'ok' }>, what: string): TemplateProviderError {
    if (result.kind === 'network') return new TemplateProviderError('unavailable', result.timedOut ? `Twilio did not answer in time (${what})` : `Twilio could not be reached (${what})`);
    const text = safeProviderText(result.error.message, twilioSecretValues(this.config), 300);
    const code = result.error.code ? ` ${result.error.code}` : '';
    const reason = result.error.code === 20003 ? 'auth_failed' : templateReasonForStatus(result.status);
    const lead = reason === 'auth_failed' ? 'Twilio rejected the channel credentials' : `Twilio refused ${what}`;
    return new TemplateProviderError(reason, `${lead} (HTTP ${result.status}${code})${text ? `: ${text}` : ''}`);
  }

  /** Every Content resource with its WhatsApp approval (follows `meta.next_page_url` on the Content API origin only). */
  async list(): Promise<MessageTemplate[]> {
    const out: MessageTemplate[] = [];
    const origin = new URL(this.base).origin;
    let next: string | null = `${this.url('ContentAndApprovals')}?PageSize=${PAGE_SIZE}`;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const result = await this.client.getJson(next);
      if (result.kind !== 'ok') throw this.fail(result, 'the template list');
      const parsed = ListPage.safeParse(result.body);
      if (!parsed.success) throw new TemplateProviderError('unavailable', 'Twilio answered the template list with an unexpected shape');
      for (const raw of parsed.data.contents) {
        const item = ContentItem.safeParse(raw);
        if (item.success) out.push(normalizeContentItem(item.data));
      }
      const url = parsed.data.meta?.next_page_url ?? null;
      next = url && URL.canParse(url) && new URL(url).origin === origin ? url : null;
    }
    return out;
  }

  /** Definition (`/v1/Content/{sid}`) + approval (`…/ApprovalRequests`); null when the content is gone. */
  async status(sid: string): Promise<MessageTemplate | null> {
    const content = await this.client.getJson(this.url('Content', sid));
    if (content.kind !== 'ok') {
      if (content.kind === 'error' && content.status === 404) return null;
      throw this.fail(content, 'the template');
    }
    const item = ContentItem.safeParse(content.body);
    if (!item.success) throw new TemplateProviderError('unavailable', 'Twilio answered the template with an unexpected shape');
    const approval = await this.client.getJson(this.url('Content', sid, 'ApprovalRequests'));
    if (approval.kind !== 'ok' && !(approval.kind === 'error' && approval.status === 404)) throw this.fail(approval, 'the approval status');
    const whatsapp = approval.kind === 'ok' ? whatsappApproval((approval.body as Record<string, unknown> | null)?.['whatsapp']) : null;
    return normalizeContentItem(item.data, whatsapp);
  }

  /** Create the content, then submit it for WhatsApp approval; the content is removed again if the submission fails. */
  async create(draft: TemplateDraft): Promise<MessageTemplate> {
    const created = await this.client.postJson(this.url('Content'), contentCreateBody(draft));
    if (created.kind !== 'ok') throw this.fail(created, 'the new template');
    const item = ContentItem.safeParse(created.body);
    if (!item.success) throw new TemplateProviderError('unavailable', 'Twilio created the template without a Content SID');
    const submitted = await this.client.postJson(this.url('Content', item.data.sid, 'ApprovalRequests', 'whatsapp'), approvalRequestBody(draft));
    if (submitted.kind !== 'ok') {
      await this.client.delete(this.url('Content', item.data.sid)).catch(() => undefined);
      throw this.fail(submitted, 'the WhatsApp approval request');
    }
    // The submission answers flat; before WhatsApp reviews it the status is `received`.
    const approval = whatsappApproval(submitted.body) ?? { status: 'received', name: draft.name, category: draft.category };
    return normalizeContentItem(item.data, { ...approval, status: approval.status || 'received', category: approval.category || draft.category });
  }

  /** Twilio keeps only its own copy by default (PM/research/10 §3.3); already gone counts as deleted. */
  async remove(sid: string): Promise<void> {
    const result = await this.client.delete(this.url('Content', sid));
    if (result.kind !== 'ok' && !(result.kind === 'error' && result.status === 404)) throw this.fail(result, 'deleting the template');
  }
}
