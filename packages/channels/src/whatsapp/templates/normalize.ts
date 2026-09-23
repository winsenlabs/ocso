import { AUTHENTICATION_BODY, placeholdersIn, templateValueKey, type MessageTemplate, type TemplateButton, type TemplateHeader, type TemplateStatus, type TemplateVariable } from '@ocso/domain';
import { z } from 'zod';
import { normalizeTemplateCategory, shortText } from '../../common/templates.js';

/**
 * Meta `message_templates` item → MessageTemplate (PM/research/10 §7, §10).
 * Placeholders are numbered per component (`{{1}}` in the header and in the
 * body are different values), or named (`parameter_format: NAMED`), so keys
 * are `header.1`, `body.first_name`, `button.0.1`. Enum casing varies, so
 * everything is compared upper-cased.
 */

const Loose = z.looseObject({});

export const MetaTemplate = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  language: z.string(),
  status: z.string().nullish(),
  category: z.string().nullish(),
  parameter_format: z.string().nullish(),
  rejected_reason: z.string().nullish(),
  components: z.array(Loose).nullish(),
});
export type MetaTemplate = z.infer<typeof MetaTemplate>;

const STATUSES: Readonly<Record<string, TemplateStatus | null>> = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  IN_APPEAL: 'PENDING',
  REJECTED: 'REJECTED',
  LIMIT_EXCEEDED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  ARCHIVED: 'DISABLED',
  // Gone (or going): not listed.
  DELETED: null,
  PENDING_DELETION: null,
};

/** Meta status → OCSO; null = deleted (hide); unknown values count as in review. */
export function metaTemplateStatus(raw: string | null | undefined): TemplateStatus | null {
  const value = raw?.trim().toUpperCase() ?? '';
  return value in STATUSES ? STATUSES[value]! : 'PENDING';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Examples: positional `body_text: [[…]]` / `header_text: […]`, or named `*_named_params: [{param_name, example}]`. */
function exampleFor(example: Record<string, unknown>, part: 'header' | 'body', placeholder: string): string | undefined {
  const named = arr(example[`${part}_text_named_params`]).map(obj).find((p) => p['param_name'] === placeholder);
  if (named) return str(named['example']);
  const positional = part === 'body' ? arr(arr(example['body_text'])[0]) : arr(example['header_text']);
  const index = Number(placeholder) - 1;
  return Number.isInteger(index) && index >= 0 ? str(positional[index]) : undefined;
}

const SUPPORTED_BUTTONS = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'OTP']);

export function normalizeMetaTemplate(item: MetaTemplate): MessageTemplate | null {
  const status = metaTemplateStatus(item.status);
  if (status === null) return null;
  const category = normalizeTemplateCategory(item.category);
  let header: TemplateHeader | null = null;
  let body = '';
  let footer: string | null = null;
  let buttons: TemplateButton[] = [];
  let unsupported: string | null = null;
  const variables: TemplateVariable[] = [];
  const addVars = (text: string, part: 'header' | 'body', example: Record<string, unknown>) => {
    for (const p of placeholdersIn(text)) variables.push({ key: templateValueKey('component', part, p), placeholder: p, part, ...optional(exampleFor(example, part, p)) });
  };
  for (const component of item.components ?? []) {
    const type = str(component['type'])?.toUpperCase();
    const example = obj(component['example']);
    if (type === 'HEADER') {
      const format = str(component['format'])?.toUpperCase() ?? 'TEXT';
      if (format === 'TEXT') {
        header = { format: 'TEXT', text: str(component['text']) ?? '' };
        addVars(header.text ?? '', 'header', example);
      } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') header = { format };
      else unsupported ??= `${format.toLowerCase()} headers cannot be sent from OCSO yet`;
    } else if (type === 'BODY') {
      body = str(component['text']) ?? (category === 'AUTHENTICATION' ? authenticationBody(component) : '');
      addVars(body, 'body', example);
    } else if (type === 'FOOTER') {
      const minutes = component['code_expiration_minutes'];
      footer = str(component['text']) ?? (typeof minutes === 'number' ? `This code expires in ${minutes} minutes.` : null);
    } else if (type === 'BUTTONS') {
      buttons = arr(component['buttons']).map(obj).map((b, index) => buttonOf(b, index, variables));
      const other = buttons.find((b) => !SUPPORTED_BUTTONS.has(b.type));
      if (other) unsupported ??= `${other.text || 'Special'} buttons (${other.type.toLowerCase()}) cannot be sent from OCSO yet`;
    } else if (type) unsupported ??= `${type.toLowerCase()} templates cannot be sent from OCSO yet`;
  }
  const rejection = shortText(item.rejected_reason);
  return {
    id: item.id,
    name: item.name,
    language: item.language,
    category,
    status,
    rejectionReason: status !== 'APPROVED' && status !== 'PENDING' && rejection && rejection.toUpperCase() !== 'NONE' ? rejection : null,
    header,
    body,
    footer,
    buttons,
    variables,
    placeholderScope: 'component',
    headerMediaRequired: header !== null && header.format !== 'TEXT',
    contentType: category === 'AUTHENTICATION' ? 'authentication' : null,
    unsupportedReason: unsupported,
  };
}

function optional(example: string | undefined): { example?: string } {
  return example ? { example } : {};
}

function authenticationBody(component: Record<string, unknown>): string {
  return component['add_security_recommendation'] === true ? `${AUTHENTICATION_BODY} For your security, do not share this code.` : AUTHENTICATION_BODY;
}

function buttonOf(b: Record<string, unknown>, index: number, variables: TemplateVariable[]): TemplateButton {
  const type = str(b['type'])?.toUpperCase() ?? 'OTHER';
  const text = str(b['text']) ?? '';
  if (type === 'URL') {
    const url = str(b['url']) ?? '';
    const sample = str(arr(b['example'])[0]) ?? str(b['example']);
    for (const p of placeholdersIn(url)) variables.push({ key: templateValueKey('component', 'button', p, index), placeholder: p, part: 'button', ...optional(sample) });
    return { type: 'URL', text, url };
  }
  if (type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text, ...(str(b['phone_number']) ? { phone: str(b['phone_number'])! } : {}) };
  if (type === 'QUICK_REPLY' || type === 'OTP' || type === 'COPY_CODE' || type === 'FLOW') return { type, text: text || (type === 'OTP' ? 'Copy code' : type.toLowerCase()) };
  return { type: 'OTHER', text: text || type.toLowerCase() };
}
