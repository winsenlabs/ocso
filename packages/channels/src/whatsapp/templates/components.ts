import { draftBodyText, draftVariableNumbers, placeholdersIn, templateValueKey, type MessageTemplate, type TemplateDraft } from '@ocso/domain';
import { TemplateProviderError } from '../../common/templates.js';

/**
 * Meta template payloads (PM/research/10 §7.2, §9): the send-time
 * `components` filled from normalized values, and the create body built from
 * a TemplateDraft (positional parameters with examples).
 */

type Component = Record<string, unknown>;

const isNamed = (placeholder: string) => !/^\d+$/.test(placeholder);

function textParam(placeholder: string, value: string): Record<string, string> {
  return isNamed(placeholder) ? { type: 'text', parameter_name: placeholder, text: value } : { type: 'text', text: value };
}

/** Placeholders in send order: positional ones by number, named ones as written. */
function ordered(text: string): string[] {
  const names = placeholdersIn(text);
  return names.every((n) => !isNamed(n)) ? [...names].sort((a, b) => Number(a) - Number(b)) : names;
}

const MEDIA_TYPE: Readonly<Record<string, string>> = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };

/** Send components for a normalized Meta template and validated values. */
export function sendComponents(template: MessageTemplate, values: Readonly<Record<string, string>>, headerMediaUrl: string | undefined): Component[] {
  const value = (part: 'header' | 'body' | 'button', placeholder: string, index = 0) => values[templateValueKey('component', part, placeholder, index)] ?? '';
  const components: Component[] = [];
  const header = template.header;
  if (header?.format === 'TEXT' && header.text && placeholdersIn(header.text).length) {
    components.push({ type: 'header', parameters: ordered(header.text).map((p) => textParam(p, value('header', p))) });
  } else if (header && header.format !== 'TEXT') {
    const type = MEDIA_TYPE[header.format];
    if (!type || !headerMediaUrl) throw new TemplateProviderError('unsupported', `${template.name} needs a ${header.format.toLowerCase()} header link`);
    components.push({ type: 'header', parameters: [{ type, [type]: { link: headerMediaUrl } }] });
  }
  const bodyPlaceholders = ordered(template.body);
  if (bodyPlaceholders.length) components.push({ type: 'body', parameters: bodyPlaceholders.map((p) => textParam(p, value('body', p))) });
  template.buttons.forEach((button, index) => {
    if (button.type === 'URL' && button.url && placeholdersIn(button.url).length) {
      components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: placeholdersIn(button.url).map((p) => ({ type: 'text', text: value('button', p, index) })) });
    }
    // Authentication: the copy-code (OTP) button carries the same code as the body.
    if (button.type === 'OTP') components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: value('body', '1') }] });
  });
  return components;
}

/** `POST /{WABA}/message_templates` body for a draft (media headers need a Resumable Upload handle — not supported). */
export function createTemplateBody(draft: TemplateDraft): Record<string, unknown> {
  const base = { name: draft.name, language: draft.language, category: draft.category, allow_category_change: draft.allowCategoryChange };
  if (draft.category === 'AUTHENTICATION') {
    const minutes = draft.authentication?.codeExpirationMinutes ?? null;
    return {
      ...base,
      components: [
        { type: 'BODY', add_security_recommendation: draft.authentication?.securityRecommendation !== false },
        ...(minutes ? [{ type: 'FOOTER', code_expiration_minutes: minutes }] : []),
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
      ],
    };
  }
  if (draft.header && draft.header.format !== 'TEXT') {
    throw new TemplateProviderError(
      'unsupported',
      'Meta needs an uploaded sample file for media headers: create this template in WhatsApp Manager (it will appear here), or use a text header',
    );
  }
  const body = draftBodyText(draft);
  const examples = draftVariableNumbers(body)
    .sort((a, b) => a - b)
    .map((n) => (draft.examples[String(n)] ?? '').trim());
  const components: Component[] = [];
  if (draft.header) components.push({ type: 'HEADER', format: 'TEXT', text: draft.header.text });
  components.push({ type: 'BODY', text: body, ...(examples.length ? { example: { body_text: [examples] } } : {}) });
  if (draft.footer) components.push({ type: 'FOOTER', text: draft.footer });
  if (draft.buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: draft.buttons.map((b) =>
        b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url } : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone } : { type: 'QUICK_REPLY', text: b.text },
      ),
    });
  }
  return { ...base, parameter_format: 'POSITIONAL', components };
}
