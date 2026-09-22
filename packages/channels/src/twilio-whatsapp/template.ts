import type { RenderedOutbound } from '../contract/types.js';
import { invalidOutbound } from '../common/errors.js';
import { TwilioContentTemplate } from './payload.js';

/**
 * Content Templates: the only way to message a customer outside the 24-hour
 * customer-service window (Twilio error 63016). Create and get the template
 * approved for WhatsApp in Twilio's Content Template Builder, then send it by
 * ContentSid (HX…) with ContentVariables, e.g. `{ "1": "₹4,200" }`.
 */

export interface TwilioTemplateInput {
  contentSid: string;
  variables?: Readonly<Record<string, string>> | undefined;
}

export function renderTwilioTemplate(input: TwilioTemplateInput): RenderedOutbound {
  const parsed = TwilioContentTemplate.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'template'}: ${issue.message}`);
    throw invalidOutbound('invalid_twilio_template', `invalid Twilio content template: ${problems.join('; ')}`);
  }
  return { kind: 'TWILIO_WHATSAPP', payload: { type: 'template', template: parsed.data }, partIndexes: [] };
}
