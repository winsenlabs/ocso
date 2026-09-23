import type { MessageTemplate, TemplateVariablePart } from './model.js';

/**
 * Template placeholders (`{{1}}`, `{{order_id}}`), filling them with values,
 * and the checks a send request must pass. Used by the API before a template
 * message is persisted and by the workspace for its live preview, so both
 * show exactly what the customer receives.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g;

/** Placeholder names in order of first appearance. */
export function placeholdersIn(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Key of a placeholder's value in a send request (see TemplateVariable.key). */
export function templateValueKey(
  scope: MessageTemplate['placeholderScope'],
  part: TemplateVariablePart,
  placeholder: string,
  buttonIndex = 0,
): string {
  if (scope === 'template') return placeholder;
  return part === 'button' ? `button.${buttonIndex}.${placeholder}` : `${part}.${placeholder}`;
}

/** Replace `{{x}}` by `resolve(x)`; unresolved placeholders stay visible. */
export function fillPlaceholders(text: string, resolve: (placeholder: string) => string | undefined): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => resolve(name) ?? whole);
}

export interface RenderedTemplate {
  header: string | null;
  body: string;
  footer: string | null;
  buttons: Array<{ type: string; text: string; url?: string | undefined }>;
  /** Plain-text projection stored with the message and shown in the timeline. */
  text: string;
}

const MEDIA_LABEL: Readonly<Record<string, string>> = { IMAGE: '[image]', VIDEO: '[video]', DOCUMENT: '[document]', LOCATION: '[location]' };

/** The template as the customer will see it with these values (missing ones stay as `{{n}}`). */
export function renderTemplate(template: MessageTemplate, values: Readonly<Record<string, string>>, headerMediaUrl?: string): RenderedTemplate {
  const fill = (text: string, part: TemplateVariablePart, index = 0) =>
    fillPlaceholders(text, (p) => {
      const value = values[templateValueKey(template.placeholderScope, part, p, index)];
      return value === undefined || value === '' ? undefined : value;
    });
  let header: string | null = null;
  if (template.header?.format === 'TEXT') header = template.header.text ? fill(template.header.text, 'header') : null;
  else if (template.header) {
    const url = headerMediaUrl ?? template.header.mediaUrl;
    const label = MEDIA_LABEL[template.header.format] ?? '[media]';
    header = url ? `${label} ${fill(url, 'header')}` : label;
  }
  const body = fill(template.body, 'body');
  // WhatsApp footers are static text.
  const footer = template.footer;
  const buttons = template.buttons.map((b, i) => ({ type: b.type, text: b.text, ...(b.url ? { url: fill(b.url, 'button', i) } : {}) }));
  const buttonLine = buttons.map((b) => `[${b.text}]`).join(' ');
  const text = [header, body, footer, buttonLine || null].filter((s): s is string => Boolean(s)).join('\n\n');
  return { header, body, footer, buttons, text };
}

export const TEMPLATE_VALUE_MAX = 1_024;

/** Why a value cannot be sent (WhatsApp rejects parameters with newlines, tabs or 5+ spaces in a row). */
export function templateValueProblem(value: string | undefined): string | null {
  if (value === undefined || !value.trim()) return 'required';
  if (value.length > TEMPLATE_VALUE_MAX) return `at most ${TEMPLATE_VALUE_MAX} characters`;
  if (/[\n\r\t]/.test(value)) return 'must be a single line (no line breaks or tabs)';
  if (/ {5,}/.test(value)) return 'must not contain more than four spaces in a row';
  return null;
}

/** Problems of a send request against its template: every variable filled, nothing unknown. */
export function templateValueProblems(
  template: MessageTemplate,
  values: Readonly<Record<string, string>>,
  headerMediaUrl?: string,
): Array<{ key: string; message: string }> {
  const problems: Array<{ key: string; message: string }> = [];
  const known = new Set(template.variables.map((v) => v.key));
  for (const variable of template.variables) {
    const problem = templateValueProblem(values[variable.key]);
    if (problem) problems.push({ key: variable.key, message: `{{${variable.placeholder}}} (${variable.part}) ${problem}` });
  }
  for (const key of Object.keys(values)) {
    if (!known.has(key)) problems.push({ key, message: `${key} is not a variable of ${template.name}` });
  }
  if (template.headerMediaRequired) {
    if (!headerMediaUrl) problems.push({ key: 'headerMediaUrl', message: 'this template needs a header media link (https)' });
    else if (!/^https:\/\/\S+$/.test(headerMediaUrl) || !URL.canParse(headerMediaUrl)) problems.push({ key: 'headerMediaUrl', message: 'header media must be an https link' });
  }
  return problems;
}
