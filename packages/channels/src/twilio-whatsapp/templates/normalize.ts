import { AUTHENTICATION_BODY, fillPlaceholders, placeholdersIn, type MessageTemplate, type TemplateButton, type TemplateHeader, type TemplateStatus, type TemplateVariable } from '@ocso/domain';
import { z } from 'zod';
import { mediaFormatOfUrl, normalizeTemplateCategory, shortText } from '../../common/templates.js';

/**
 * Twilio Content API item (`/v1/ContentAndApprovals`, `/v1/Content`) →
 * MessageTemplate (PM/research/10 §2, §3.1, §10). Variables are global to
 * the content (`{{1}}` anywhere is key "1"); their default values are the
 * approval samples, shown as examples.
 */

export const ContentItem = z.looseObject({
  sid: z.string().regex(/^HX[0-9a-fA-F]{32}$/),
  friendly_name: z.string().nullish(),
  language: z.string().nullish(),
  variables: z.record(z.string(), z.unknown()).nullish(),
  types: z.record(z.string(), z.unknown()).nullish(),
  approval_requests: z.unknown().optional(),
});
export type ContentItem = z.infer<typeof ContentItem>;

const Approval = z.looseObject({
  name: z.string().nullish(),
  category: z.string().nullish(),
  content_type: z.string().nullish(),
  status: z.string().nullish(),
  rejection_reason: z.string().nullish(),
});
export type ContentApproval = z.infer<typeof Approval>;

/** Flat (spec) or channel-keyed `{ whatsapp: {…} }` (seen in the wild), or an array; missing/empty = unsubmitted. */
export function whatsappApproval(raw: unknown): ContentApproval | null {
  if (!raw || typeof raw !== 'object') return null;
  let candidate: unknown = raw;
  if (Array.isArray(raw)) candidate = raw.find((x) => x && typeof x === 'object' && ((x as Record<string, unknown>)['type'] === 'whatsapp' || 'status' in x));
  else if ('whatsapp' in raw) candidate = (raw as Record<string, unknown>)['whatsapp'];
  const parsed = Approval.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const STATUSES: Readonly<Record<string, TemplateStatus>> = {
  unsubmitted: 'DRAFT',
  received: 'PENDING',
  pending: 'PENDING',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  paused: 'PAUSED',
  disabled: 'DISABLED',
};

/** Twilio approval status (lower-case) → OCSO; empty = never submitted; unknown values count as in review. */
export function twilioTemplateStatus(raw: string | null | undefined): TemplateStatus {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!value) return 'DRAFT';
  return STATUSES[value] ?? 'PENDING';
}

const SUPPORTED = ['whatsapp/authentication', 'whatsapp/card', 'twilio/card', 'twilio/call-to-action', 'twilio/quick-reply', 'twilio/media', 'twilio/text'] as const;

const Action = z.looseObject({
  type: z.string().nullish(),
  title: z.string().nullish(),
  url: z.string().nullish(),
  phone: z.string().nullish(),
  copy_code_text: z.string().nullish(),
});
const TypeBody = z.looseObject({
  body: z.string().nullish(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  footer: z.string().nullish(),
  header_text: z.string().nullish(),
  media: z.array(z.string()).nullish(),
  actions: z.array(Action).nullish(),
  add_security_recommendation: z.boolean().nullish(),
  code_expiration_minutes: z.number().nullish(),
});
type TypeBody = z.infer<typeof TypeBody>;

function buttonOf(action: z.infer<typeof Action>, quickReply: boolean): TemplateButton {
  const text = action.title ?? action.copy_code_text ?? '';
  const type = (action.type ?? (quickReply ? 'QUICK_REPLY' : '')).toUpperCase();
  if (type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text };
  if (type === 'URL') return { type: 'URL', text, ...(action.url ? { url: action.url } : {}) };
  if (type === 'PHONE_NUMBER' || type === 'PHONE') return { type: 'PHONE_NUMBER', text, ...(action.phone ? { phone: action.phone } : {}) };
  if (type === 'COPY_CODE') return { type: 'COPY_CODE', text: text || 'Copy code' };
  return { type: 'OTHER', text };
}

function parts(contentType: string, spec: TypeBody, samples: Record<string, unknown>): { header: TemplateHeader | null; body: string; footer: string | null; buttons: TemplateButton[] } {
  const media = spec.media?.[0];
  // A variable media path (`https://files.example.com/{{1}}`) gets its type from the approval sample.
  const sampleUrl = media ? fillPlaceholders(media, (p) => (typeof samples[p] === 'string' ? (samples[p] as string) : undefined)) : '';
  const mediaHeader: TemplateHeader | null = media ? { format: mediaFormatOfUrl(sampleUrl), mediaUrl: media } : null;
  const buttons = (spec.actions ?? []).map((a) => buttonOf(a, contentType === 'twilio/quick-reply'));
  switch (contentType) {
    case 'whatsapp/authentication': {
      const body = spec.add_security_recommendation === false ? AUTHENTICATION_BODY : `${AUTHENTICATION_BODY} For your security, do not share this code.`;
      const minutes = spec.code_expiration_minutes;
      return { header: null, body, footer: minutes ? `This code expires in ${minutes} minutes.` : null, buttons: [{ type: 'OTP', text: spec.actions?.[0]?.copy_code_text ?? 'Copy code' }] };
    }
    case 'twilio/card':
      return { header: mediaHeader, body: spec.title ?? '', footer: spec.subtitle ?? null, buttons };
    case 'whatsapp/card':
      return { header: spec.header_text ? { format: 'TEXT', text: spec.header_text } : mediaHeader, body: spec.body ?? '', footer: spec.footer ?? null, buttons };
    default:
      return { header: contentType === 'twilio/media' ? mediaHeader : null, body: spec.body ?? '', footer: null, buttons };
  }
}

function variablesOf(item: ContentItem, header: TemplateHeader | null, body: string, buttons: readonly TemplateButton[]): TemplateVariable[] {
  const defaults = item.variables ?? {};
  const found: TemplateVariable[] = [];
  const add = (text: string | undefined, part: TemplateVariable['part']) => {
    for (const placeholder of placeholdersIn(text ?? '')) {
      if (found.some((v) => v.key === placeholder)) continue;
      const example = defaults[placeholder];
      found.push({ key: placeholder, placeholder, part, ...(typeof example === 'string' && example ? { example } : {}) });
    }
  };
  add(header?.text ?? header?.mediaUrl, 'header');
  add(body, 'body');
  for (const b of buttons) add(b.url, 'button');
  return found;
}

/** Normalize one Content item; `approval` overrides the item's own approval_requests. */
export function normalizeContentItem(item: ContentItem, approval: ContentApproval | null = whatsappApproval(item.approval_requests)): MessageTemplate {
  const types = item.types ?? {};
  const submitted = approval?.content_type && approval.content_type in types ? approval.content_type : undefined;
  const contentType = submitted ?? SUPPORTED.find((t) => t in types) ?? Object.keys(types)[0] ?? 'unknown';
  const supported = (SUPPORTED as readonly string[]).includes(contentType);
  const spec = TypeBody.safeParse(types[contentType]);
  const { header, body, footer, buttons } = spec.success ? parts(contentType, spec.data, item.variables ?? {}) : { header: null, body: '', footer: null, buttons: [] };
  const status = twilioTemplateStatus(approval?.status);
  const variables = contentType === 'whatsapp/authentication' ? [{ key: '1', placeholder: '1', part: 'body' as const, example: '123456' }] : variablesOf(item, header, body, buttons);
  return {
    id: item.sid,
    name: approval?.name || item.friendly_name || item.sid,
    language: item.language ?? '',
    category: normalizeTemplateCategory(approval?.category),
    status,
    rejectionReason: status === 'REJECTED' || status === 'PAUSED' || status === 'DISABLED' ? shortText(approval?.rejection_reason, 600) : null,
    header,
    body,
    footer,
    buttons,
    variables,
    placeholderScope: 'template',
    headerMediaRequired: false,
    contentType,
    unsupportedReason: supported && spec.success ? null : `${contentType} content cannot be sent as a WhatsApp template from OCSO yet`,
  };
}
