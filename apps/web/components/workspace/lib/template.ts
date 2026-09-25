import { MessageTemplateSchema, TEMPLATE_STATUS_LABELS, isTemplateSendable, renderTemplate, templateValueProblems, type MessageTemplate, type RenderedTemplate } from '@ocso/domain';
import { z } from 'zod';

/**
 * Workspace helpers for message templates (docs/07 §3): the reply-window
 * line, the picker's search and hints, and the variables form. Validation
 * and the preview use the same @ocso/domain functions as the API, so what
 * the exec sees is what the customer receives.
 */

/** The channel's customer-service window (its length comes from the channel adapter). */
export interface WindowState {
  open: boolean;
  closesAt: string | null;
  hours?: number | undefined;
}

export interface WindowLine {
  tone: 'open' | 'closed';
  text: string;
}

function hoursMinutes(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m` : 'under a minute';
}

/** "reply window open · closes in 3h 12m" / "24-hour reply window closed — send an approved template". */
export function windowLine(window: WindowState | null, now: number): WindowLine | null {
  if (!window) return null;
  const closes = window.closesAt ? Date.parse(window.closesAt) : NaN;
  if (window.open && Number.isFinite(closes) && closes > now) return { tone: 'open', text: `reply window open · closes in ${hoursMinutes((closes - now) / 1000)}` };
  if (!window.closesAt) return { tone: 'closed', text: 'No customer message yet — start with an approved template' };
  return { tone: 'closed', text: `${window.hours ? `${window.hours}-hour ` : ''}reply window closed — send an approved template` };
}

/** Free-form replies are possible now (no window on this channel, or it is open). */
export function canReplyFreely(window: WindowState | null, now: number): boolean {
  return windowLine(window, now)?.tone !== 'closed';
}

const CATEGORY_ORDER = { UTILITY: 0, AUTHENTICATION: 1, MARKETING: 2 } as const;

/** Sendable first, then by category and name; `query` matches name, text, category and language. */
export function searchTemplates<T extends MessageTemplate>(templates: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? templates.filter((t) => [t.name, t.body, t.header?.text ?? '', t.category ?? '', t.language].some((field) => field.toLowerCase().includes(q)))
    : [...templates];
  return hits.sort(
    (a, b) =>
      Number(isTemplateSendable(b)) - Number(isTemplateSendable(a)) ||
      (CATEGORY_ORDER[a.category ?? 'MARKETING'] ?? 3) - (CATEGORY_ORDER[b.category ?? 'MARKETING'] ?? 3) ||
      a.name.localeCompare(b.name),
  );
}

/** Why a listed template cannot be sent right now (null when it can). */
export function templateHint(template: MessageTemplate): string | null {
  if (template.unsupportedReason) return template.unsupportedReason;
  if (template.status === 'APPROVED') return null;
  const label = TEMPLATE_STATUS_LABELS[template.status];
  return template.rejectionReason ? `${label}: ${template.rejectionReason}` : `${label} — only approved templates can be sent`;
}

export const CATEGORY_LABELS: Readonly<Record<string, string>> = { UTILITY: 'utility', MARKETING: 'marketing', AUTHENTICATION: 'authentication' };

/** Input label for a variable: `{{1}} · body`. */
export function variableLabel(variable: MessageTemplate['variables'][number]): string {
  return `{{${variable.placeholder}}} · ${variable.part}`;
}

export function emptyValues(template: MessageTemplate): Record<string, string> {
  return Object.fromEntries(template.variables.map((v) => [v.key, '']));
}

/** Messages keyed by variable key (and `headerMediaUrl`), from the API's own rules. */
export function valueErrors(template: MessageTemplate, values: Readonly<Record<string, string>>, headerMediaUrl: string): Record<string, string> {
  const problems = templateValueProblems(template, trimmed(values), headerMediaUrl.trim() || undefined);
  return Object.fromEntries(problems.map((p) => [p.key, p.message]));
}

export function trimmed(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]));
}

/** Live preview with the values typed so far (unfilled variables stay visible as `{{n}}`). */
export function previewOf(template: MessageTemplate, values: Readonly<Record<string, string>>, headerMediaUrl: string): RenderedTemplate {
  return renderTemplate(template, trimmed(values), headerMediaUrl.trim() || undefined);
}

/** Error text for the picker when the list could not be used. */
export function listProblemText(problem: { code: string; message: string }): string {
  if (problem.code === 'templates_not_configured') return `${problem.message}. A Tech admin adds it under Integrations → Channels.`;
  if (problem.code === 'templates_auth_failed') return `${problem.message}. A Tech admin can check the credentials with Test on the channel.`;
  return problem.message;
}

/** GET /api/channels/:id/templates (browser side; the proxy forwards GET /v1/channels/:id/templates). */
export const TemplateListResponseSchema = z.object({
  channel: z.object({ id: z.string(), kind: z.string(), name: z.string() }),
  templates: z.array(MessageTemplateSchema.extend({ submission: z.unknown().optional() })),
  fetchedAt: z.string().nullable(),
  problem: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;
