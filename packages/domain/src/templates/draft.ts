import { z } from 'zod';
import { TEMPLATE_CATEGORIES, type MessageTemplate, type TemplateCategory, type TemplateStatus } from './model.js';
import { placeholdersIn, templateValueKey } from './render.js';

/**
 * A template a CS Lead writes in OCSO and submits to the provider for
 * WhatsApp approval (Twilio Content API + ApprovalRequests, or Meta
 * message_templates). Deliberately the common subset both providers accept:
 * numbered body variables with examples, a static text or media header, a
 * static footer, and either quick replies or call-to-action buttons.
 * Authentication templates use WhatsApp's fixed code text.
 */

export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
export const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
/**
 * The stricter of Twilio's and Meta's limits (PM/research/10 §3.1, §7.2):
 * body 1,024, header/footer 60, button text 20 (Twilio; Meta allows 25),
 * up to 10 quick replies, at most 2 website buttons and 1 call button.
 */
export const TEMPLATE_LIMITS = { body: 1_024, header: 60, footer: 60, buttonText: 20, quickReplies: 10, urlButtons: 2, example: 200 } as const;

const QuickReply = z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim() });
const UrlButton = z.object({ type: z.literal('URL'), text: z.string().trim(), url: z.string().trim() });
const PhoneButton = z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().trim(), phone: z.string().trim() });

export const TemplateDraftSchema = z.object({
  name: z.string().trim().max(512),
  language: z.string().trim().max(16),
  category: z.enum(TEMPLATE_CATEGORIES),
  /** Let the provider re-categorize instead of rejecting a mis-categorized template. */
  allowCategoryChange: z.boolean().default(true),
  header: z
    .discriminatedUnion('format', [
      z.object({ format: z.literal('TEXT'), text: z.string().trim() }),
      z.object({ format: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']), mediaUrl: z.string().trim() }),
    ])
    .nullable()
    .default(null),
  body: z.string().max(4_000).default(''),
  footer: z.string().trim().max(200).nullable().default(null),
  buttons: z.array(z.discriminatedUnion('type', [QuickReply, UrlButton, PhoneButton])).max(10).default([]),
  /** Example value per body variable number, e.g. `{ "1": "Priya" }` — providers require them for review. */
  examples: z.record(z.string(), z.string().max(1_024)).default({}),
  /** AUTHENTICATION only: WhatsApp's fixed "<code> is your verification code" text with a copy-code button. */
  authentication: z
    .object({ codeExpirationMinutes: z.number().int().min(1).max(90).nullable().default(null), securityRecommendation: z.boolean().default(true) })
    .nullable()
    .default(null),
});
export type TemplateDraft = z.output<typeof TemplateDraftSchema>;
export type TemplateDraftInput = z.input<typeof TemplateDraftSchema>;

export interface DraftIssue {
  field: string;
  message: string;
}

export interface DraftCheck {
  /** Blocking: the provider would reject the template (or OCSO cannot build it). */
  problems: DraftIssue[];
  /** Advisory: likely re-categorization or review trouble. */
  warnings: DraftIssue[];
}

const PROMOTIONAL = /\b(offer|offers|discount|sale|deal|deals|promo|promotion|coupon|free|cashback|buy now|shop now|limited time|% off|exclusive|upgrade now|save \d+)\b/i;

/** Body variable numbers in order of appearance (after the name check). */
export function draftVariableNumbers(body: string): number[] {
  return placeholdersIn(body)
    .filter((p) => /^\d+$/.test(p))
    .map(Number);
}

export const AUTHENTICATION_BODY = '{{1}} is your verification code.';

/** Body text a draft will have at the provider (authentication templates use WhatsApp's fixed text). */
export function draftBodyText(draft: Pick<TemplateDraft, 'category' | 'body' | 'authentication'>): string {
  if (draft.category !== 'AUTHENTICATION') return draft.body;
  return draft.authentication?.securityRecommendation === false ? AUTHENTICATION_BODY : `${AUTHENTICATION_BODY} For your security, do not share this code.`;
}

function checkBody(draft: TemplateDraft, problems: DraftIssue[], warnings: DraftIssue[]): void {
  const body = draft.body;
  if (!body.trim()) return void problems.push({ field: 'body', message: 'Write the message text' });
  if (body.length > TEMPLATE_LIMITS.body) problems.push({ field: 'body', message: `At most ${TEMPLATE_LIMITS.body} characters` });
  const names = placeholdersIn(body);
  const named = names.filter((n) => !/^\d+$/.test(n));
  if (named.length) problems.push({ field: 'body', message: `Use numbered variables such as {{1}}, not {{${named[0]}}}` });
  const numbers = draftVariableNumbers(body);
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.some((n, i) => n !== i + 1)) problems.push({ field: 'body', message: 'Number variables in order from {{1}} without gaps' });
  // Meta counts a variable followed only by punctuation as "at the end".
  if (/^\s*\{\{[^}]*\}\}/.test(body) || /\{\{[^}]*\}\}[\s\p{P}]*$/u.test(body)) problems.push({ field: 'body', message: 'The text cannot start or end with a variable' });
  if (/\}\}\s*\{\{/.test(body)) problems.push({ field: 'body', message: 'Put words between variables ({{1}}{{2}} is rejected)' });
  for (const n of numbers) {
    const example = draft.examples[String(n)]?.trim();
    if (!example) problems.push({ field: `examples.${n}`, message: `Give an example value for {{${n}}}` });
    else if (example.length > TEMPLATE_LIMITS.example) problems.push({ field: `examples.${n}`, message: `Example for {{${n}}}: at most ${TEMPLATE_LIMITS.example} characters` });
    else if (/[\n\r\t]/.test(example)) problems.push({ field: `examples.${n}`, message: `Example for {{${n}}} must be a single line` });
  }
  // WhatsApp review: at least 2x+1 words of plain text for x variables.
  const words = body.replace(/\{\{[^}]*\}\}/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  if (numbers.length && words < numbers.length * 2 + 1) problems.push({ field: 'body', message: `Too many variables for the text: ${numbers.length} variable(s) need at least ${numbers.length * 2 + 1} words around them` });
  if (/\t| {5,}/.test(body)) warnings.push({ field: 'body', message: 'Tabs or more than four spaces in a row are often rejected in review' });
}

function checkParts(draft: TemplateDraft, problems: DraftIssue[]): void {
  const { header, footer, buttons } = draft;
  if (header?.format === 'TEXT') {
    if (!header.text) problems.push({ field: 'header', message: 'Write the header text or remove the header' });
    if (header.text.length > TEMPLATE_LIMITS.header) problems.push({ field: 'header', message: `Header: at most ${TEMPLATE_LIMITS.header} characters` });
    if (placeholdersIn(header.text).length) problems.push({ field: 'header', message: 'Variables are supported in the message text only' });
  } else if (header && !isHttpsUrl(header.mediaUrl)) {
    problems.push({ field: 'header', message: 'The header media must be a public https link' });
  }
  if (footer) {
    if (footer.length > TEMPLATE_LIMITS.footer) problems.push({ field: 'footer', message: `Footer: at most ${TEMPLATE_LIMITS.footer} characters` });
    if (placeholdersIn(footer).length) problems.push({ field: 'footer', message: 'The footer cannot contain variables' });
  }
  const quick = buttons.filter((b) => b.type === 'QUICK_REPLY');
  const cta = buttons.filter((b) => b.type !== 'QUICK_REPLY');
  if (quick.length && cta.length) problems.push({ field: 'buttons', message: 'Use either quick replies or call-to-action buttons, not both' });
  if (quick.length > TEMPLATE_LIMITS.quickReplies) problems.push({ field: 'buttons', message: `At most ${TEMPLATE_LIMITS.quickReplies} quick replies` });
  if (cta.filter((b) => b.type === 'URL').length > TEMPLATE_LIMITS.urlButtons || cta.filter((b) => b.type === 'PHONE_NUMBER').length > 1) {
    problems.push({ field: 'buttons', message: `At most ${TEMPLATE_LIMITS.urlButtons} website buttons and one call button` });
  }
  buttons.forEach((b, i) => {
    if (!b.text) problems.push({ field: `buttons.${i}`, message: 'Button text is required' });
    else if (b.text.length > TEMPLATE_LIMITS.buttonText) problems.push({ field: `buttons.${i}`, message: `Button text: at most ${TEMPLATE_LIMITS.buttonText} characters` });
    if (b.type === 'URL' && (!isHttpsUrl(b.url) || placeholdersIn(b.url).length)) problems.push({ field: `buttons.${i}`, message: 'Website buttons need a fixed https link' });
    if (b.type === 'PHONE_NUMBER' && !/^\+[1-9]\d{6,14}$/.test(b.phone)) problems.push({ field: `buttons.${i}`, message: 'Call buttons need a phone number like +919812341208' });
  });
}

function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/.test(value) && URL.canParse(value);
}

function checkCategory(draft: TemplateDraft, warnings: DraftIssue[]): void {
  if (draft.category === 'MARKETING') return;
  const text = [draft.header?.format === 'TEXT' ? draft.header.text : '', draft.body, draft.footer ?? '', ...draft.buttons.map((b) => b.text)].join(' ');
  const hit = PROMOTIONAL.exec(text);
  if (hit && draft.category === 'UTILITY') {
    warnings.push({
      field: 'category',
      message: `"${hit[0]}" reads as promotional: WhatsApp may re-categorize this as Marketing (billed as marketing, and customers can opt out)`,
    });
  }
}

/** Everything a provider would reject, plus advisory warnings; the API and the builder use the same rules. */
export function checkTemplateDraft(draft: TemplateDraft): DraftCheck {
  const problems: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];
  if (!TEMPLATE_NAME.test(draft.name)) problems.push({ field: 'name', message: 'Use lower-case letters, digits and underscores, e.g. payment_reminder' });
  if (!TEMPLATE_LANGUAGE.test(draft.language)) problems.push({ field: 'language', message: 'Use a language code such as en, en_US or hi' });
  if (draft.category === 'AUTHENTICATION') {
    if (draft.header || draft.footer || draft.buttons.length) {
      problems.push({ field: 'category', message: 'Authentication templates use WhatsApp’s fixed code text: remove the header, footer and buttons' });
    }
    return { problems, warnings };
  }
  checkBody(draft, problems, warnings);
  checkParts(draft, problems);
  checkCategory(draft, warnings);
  return { problems, warnings };
}

/** Plain-language guidance for the category picker. */
export const TEMPLATE_CATEGORY_GUIDANCE: Readonly<Record<TemplateCategory, string>> = {
  UTILITY: 'Updates about something the customer already asked for or bought: payment due, order shipped, case update. No offers.',
  MARKETING: 'Anything promotional or that invites a new purchase: offers, reminders to buy, newsletters. Customers can opt out; billed at marketing rates.',
  AUTHENTICATION: 'One-time passcodes only. WhatsApp fixes the text (“<code> is your verification code”) and adds a copy-code button.',
};

/**
 * The normalized template a draft becomes at the provider — used for the
 * builder's live preview and for OCSO-submitted templates the provider has
 * not listed yet.
 */
export function draftAsTemplate(
  draft: TemplateDraft,
  meta: { id: string; status: TemplateStatus; rejectionReason?: string | null; scope: MessageTemplate['placeholderScope']; contentType?: string | null },
): MessageTemplate {
  const auth = draft.category === 'AUTHENTICATION';
  const numbers = auth ? [1] : draftVariableNumbers(draft.body);
  const minutes = draft.authentication?.codeExpirationMinutes ?? null;
  return {
    id: meta.id,
    name: draft.name,
    language: draft.language,
    category: draft.category,
    status: meta.status,
    rejectionReason: meta.rejectionReason ?? null,
    header: auth || !draft.header ? null : draft.header.format === 'TEXT' ? { format: 'TEXT', text: draft.header.text } : { format: draft.header.format, mediaUrl: draft.header.mediaUrl },
    body: draftBodyText(draft),
    footer: auth ? (minutes ? `This code expires in ${minutes} minutes.` : null) : draft.footer,
    buttons: auth
      ? [{ type: 'OTP', text: 'Copy code' }]
      : draft.buttons.map((b) => (b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url } : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone: b.phone } : { type: 'QUICK_REPLY', text: b.text })),
    variables: numbers.map((n) => {
      const example = auth ? '123456' : draft.examples[String(n)];
      return { key: templateValueKey(meta.scope, 'body', String(n)), placeholder: String(n), part: 'body', ...(example ? { example } : {}) };
    }),
    placeholderScope: meta.scope,
    headerMediaRequired: false,
    contentType: meta.contentType ?? null,
    unsupportedReason: null,
  };
}
