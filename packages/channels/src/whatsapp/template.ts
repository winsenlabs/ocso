import type { RenderedOutbound } from '../contract/types.js';
import { invalidOutbound } from '../common/errors.js';
import { WhatsAppTemplate } from './payload.js';

/**
 * Template messages: the only way to message a customer outside the 24-hour
 * customer-service window (Meta error 131047). Templates must be approved in
 * WhatsApp Manager; components follow the Cloud API shape, e.g.
 * `[{ type: 'body', parameters: [{ type: 'text', text: '₹4,200' }] }]`.
 */

export interface WhatsAppTemplateInput {
  name: string;
  language: string;
  components?: ReadonlyArray<Readonly<Record<string, unknown>>> | undefined;
}

export function renderWhatsAppTemplate(input: WhatsAppTemplateInput): RenderedOutbound {
  const parsed = WhatsAppTemplate.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'template'}: ${issue.message}`);
    throw invalidOutbound('invalid_whatsapp_template', `invalid WhatsApp template: ${problems.join('; ')}`);
  }
  return { kind: 'WHATSAPP', payload: { type: 'template', template: parsed.data }, partIndexes: [] };
}
