import {
  TemplateDraftSchema,
  checkTemplateDraft,
  draftAsTemplate,
  draftVariableNumbers,
  renderTemplate,
  type DraftCheck,
  type RenderedTemplate,
  type TemplateCategory,
  type TemplateDraft,
  type TemplateDraftInput,
} from '@ocso/domain';

/**
 * The "New template" builder's form state → TemplateDraft (the API's input),
 * with the same checks the API runs, a provider-specific rule, and the live
 * preview filled with the example values.
 */

export type HeaderKind = 'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
export type ButtonKind = 'NONE' | 'QUICK_REPLY' | 'CTA';

export interface CtaButton {
  type: 'URL' | 'PHONE_NUMBER';
  text: string;
  value: string;
}

export interface BuilderForm {
  name: string;
  language: string;
  category: TemplateCategory;
  allowCategoryChange: boolean;
  headerKind: HeaderKind;
  headerText: string;
  headerUrl: string;
  body: string;
  footer: string;
  buttonKind: ButtonKind;
  quickReplies: string[];
  ctas: CtaButton[];
  examples: Record<string, string>;
  codeExpirationMinutes: string;
  securityRecommendation: boolean;
}

export const EMPTY_FORM: BuilderForm = {
  name: '',
  language: 'en',
  category: 'UTILITY',
  allowCategoryChange: true,
  headerKind: 'NONE',
  headerText: '',
  headerUrl: '',
  body: '',
  footer: '',
  buttonKind: 'NONE',
  quickReplies: [''],
  ctas: [{ type: 'URL', text: '', value: '' }],
  examples: {},
  codeExpirationMinutes: '',
  securityRecommendation: true,
};

/** Common WhatsApp template language codes for the language field's suggestions. */
export const LANGUAGE_SUGGESTIONS = ['en', 'en_US', 'en_GB', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur', 'ar', 'es', 'pt_BR', 'fr', 'de', 'id'] as const;

/** Body variable numbers, sorted and unique (one example input each). */
export function bodyVariables(body: string): number[] {
  return [...new Set(draftVariableNumbers(body))].sort((a, b) => a - b);
}

/** The next unused variable, for the "Add variable" button. */
export function nextVariable(body: string): string {
  const numbers = bodyVariables(body);
  return `{{${(numbers.at(-1) ?? 0) + 1}}}`;
}

export function formToDraft(form: BuilderForm): TemplateDraftInput {
  const auth = form.category === 'AUTHENTICATION';
  const minutes = Number.parseInt(form.codeExpirationMinutes, 10);
  const header: TemplateDraftInput['header'] =
    auth || form.headerKind === 'NONE' ? null : form.headerKind === 'TEXT' ? { format: 'TEXT', text: form.headerText } : { format: form.headerKind, mediaUrl: form.headerUrl };
  const buttons: NonNullable<TemplateDraftInput['buttons']> = auth
    ? []
    : form.buttonKind === 'QUICK_REPLY'
      ? form.quickReplies.map((text) => ({ type: 'QUICK_REPLY' as const, text }))
      : form.buttonKind === 'CTA'
        ? form.ctas.map((b) => (b.type === 'URL' ? { type: 'URL' as const, text: b.text, url: b.value } : { type: 'PHONE_NUMBER' as const, text: b.text, phone: b.value }))
        : [];
  const numbers = bodyVariables(form.body);
  return {
    name: form.name.trim(),
    language: form.language.trim(),
    category: form.category,
    allowCategoryChange: form.allowCategoryChange,
    header,
    body: auth ? '' : form.body,
    footer: auth || !form.footer.trim() ? null : form.footer,
    buttons,
    examples: auth ? {} : Object.fromEntries(numbers.map((n) => [String(n), form.examples[String(n)] ?? ''])),
    authentication: auth ? { codeExpirationMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null, securityRecommendation: form.securityRecommendation } : null,
  };
}

/** Rules one provider adds to the common ones (the API reports the same through the adapter). */
export function providerProblems(channelKind: string, draft: TemplateDraft): DraftCheck['problems'] {
  if (channelKind === 'WHATSAPP' && draft.header && draft.header.format !== 'TEXT') {
    return [{ field: 'header', message: 'Meta needs an uploaded sample for media headers: create this one in WhatsApp Manager (it will show up here), or use a text header' }];
  }
  return [];
}

export interface BuilderState {
  draft: TemplateDraft | null;
  check: DraftCheck;
  preview: RenderedTemplate;
}

export function builderState(form: BuilderForm, channelKind: string): BuilderState {
  const parsed = TemplateDraftSchema.safeParse(formToDraft(form));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => ({ field: i.path.join('.') || 'template', message: i.message }));
    return { draft: null, check: { problems, warnings: [] }, preview: { header: null, body: form.body, footer: null, buttons: [], text: form.body } };
  }
  const draft = parsed.data;
  const check = checkTemplateDraft(draft);
  const problems = [...check.problems, ...providerProblems(channelKind, draft)];
  const scope = channelKind === 'WHATSAPP' ? 'component' : 'template';
  const template = draftAsTemplate(draft, { id: 'preview', status: 'DRAFT', scope });
  const values = Object.fromEntries(template.variables.map((v) => [v.key, v.example ?? '']));
  return { draft, check: { problems, warnings: check.warnings }, preview: renderTemplate(template, values) };
}
