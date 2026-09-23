'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { TemplateDraftSchema, type DraftIssue, type TemplateDraftInput } from '@ocso/domain';
import { z } from 'zod';
import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import { TemplateViewSchema } from '../api/templates';
import { getSession } from '../session';

/**
 * Message template management (docs/07 §3): create = submit for the
 * provider's review, and delete. `message_templates.manage` (CS Lead for
 * their teams' channels, Tech Admin); the API enforces the channel scope.
 */

const Id = z.uuid();
const TemplateId = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);

export type CreateTemplateResult =
  | { ok: true; name: string; status: string; warnings: DraftIssue[] }
  | { ok: false; message: string; problems: DraftIssue[] };

async function denied(): Promise<string | null> {
  const session = await getSession();
  if (!session) return 'Your session has ended. Sign in again.';
  return session.permissions.has(Permission.MESSAGE_TEMPLATES_MANAGE) ? null : 'Your role cannot manage message templates.';
}

const Created = z.object({ template: TemplateViewSchema, warnings: z.array(z.object({ field: z.string(), message: z.string() })) });

export async function createTemplateAction(channelId: string, input: TemplateDraftInput): Promise<CreateTemplateResult> {
  if (!Id.safeParse(channelId).success) return { ok: false, message: 'Unknown channel', problems: [] };
  const parsed = TemplateDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid template', problems: [] };
  const refusal = await denied();
  if (refusal) return { ok: false, message: refusal, problems: [] };
  try {
    const res = await api.post(`/v1/channels/${encodeURIComponent(channelId)}/templates`, parsed.data, Created, { timeoutMs: 45_000 });
    refresh();
    return { ok: true, name: res.template.name, status: res.template.status, warnings: res.warnings };
  } catch (err) {
    // The builder checks the same rules first; the API's message lists anything it still refuses.
    return { ok: false, message: err instanceof ApiError ? err.message : describeApiError(err), problems: [] };
  }
}

export async function deleteTemplateAction(channelId: string, templateId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!Id.safeParse(channelId).success || !TemplateId.safeParse(templateId).success) return { ok: false, message: 'Unknown template' };
  const refusal = await denied();
  if (refusal) return { ok: false, message: refusal };
  try {
    await api.command('DELETE', `/v1/channels/${encodeURIComponent(channelId)}/templates/${encodeURIComponent(templateId)}`, undefined, { timeoutMs: 30_000 });
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
  refresh();
  return { ok: true };
}
