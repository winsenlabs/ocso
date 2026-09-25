'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { TemplateDraftSchema, type DraftIssue, type TemplateDraftInput } from '@ocso/domain';
import { z } from 'zod';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import { TemplateViewSchema } from '../api/templates';
import { getSession } from '../session';

/**
 * Message templates under maker–checker (docs/archive/specs/07 §3, PM/research/11 §4): a
 * draft is saved in OCSO only (`message_templates.manage`, the Lead's teams'
 * channels); submitting it to the provider and deleting a template
 * (`message_templates.delete`, Head) are proposals — `approval_required` until
 * `approval` names a checker. The API enforces all of it.
 */

const Id = z.uuid();
const TemplateId = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const Approval = z.union([z.object({ checkerId: Id, reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);
export type TemplateApproval = z.input<typeof Approval>;
const enc = encodeURIComponent;

export type DraftResult = { ok: true; recordId: string; name: string; problems: DraftIssue[]; warnings: DraftIssue[] } | { ok: false; message: string; problems: DraftIssue[] };
export type TemplateActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined };

async function denied(permission: Permission = Permission.MESSAGE_TEMPLATES_MANAGE): Promise<string | null> {
  const session = await getSession();
  if (!session) return 'Your session has ended. Sign in again.';
  return session.permissions.has(permission) ? null : permission === Permission.MESSAGE_TEMPLATES_DELETE ? 'Your role cannot delete message templates.' : 'Your role cannot manage message templates.';
}

const Issue = z.object({ field: z.string(), message: z.string() });
const Saved = z.object({ template: TemplateViewSchema, problems: z.array(Issue).default([]), warnings: z.array(Issue).default([]) });
const Proposal = ProposedSchema.transform((b) => ({ proposalId: b.proposal.id, title: b.proposal.title }));

/** Save a new draft, or (`recordId`) edit one the provider has never seen. Nothing is sent to the provider here. */
export async function saveTemplateDraftAction(channelId: string, input: TemplateDraftInput, recordId?: string): Promise<DraftResult> {
  if (!Id.safeParse(channelId).success || (recordId !== undefined && !Id.safeParse(recordId).success)) return { ok: false, message: 'Unknown template', problems: [] };
  const parsed = TemplateDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid template', problems: [] };
  const refusal = await denied();
  if (refusal) return { ok: false, message: refusal, problems: [] };
  try {
    const base = `/v1/channels/${enc(channelId)}/templates`;
    const res = recordId ? await api.put(`${base}/drafts/${enc(recordId)}`, parsed.data, Saved) : await api.post(base, parsed.data, Saved);
    refresh();
    return { ok: true, recordId: res.template.submission?.recordId ?? res.template.id, name: res.template.name, problems: res.problems, warnings: res.warnings };
  } catch (err) {
    return { ok: false, message: err instanceof ApiError ? err.message : describeApiError(err), problems: [] };
  }
}

/** Submit a draft to the provider: always a proposal (`approval_required` until a checker is named). */
export async function submitTemplateAction(channelId: string, recordId: string, approval?: TemplateApproval): Promise<TemplateActionResult<{ proposalId: string; title: string }>> {
  const parsed = z.object({ channelId: Id, recordId: Id, approval: Approval.optional() }).safeParse({ channelId, recordId, approval });
  if (!parsed.success) return { ok: false, message: 'Unknown template' };
  const refusal = await denied();
  if (refusal) return { ok: false, message: refusal };
  try {
    const i = parsed.data;
    const res = await api.post(`/v1/channels/${enc(i.channelId)}/templates/drafts/${enc(i.recordId)}/submit`, i.approval ? { approval: i.approval } : {}, Proposal);
    refresh();
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

/** Delete (Head): always a proposal; once approved the worker deletes it at the provider. */
export async function deleteTemplateAction(channelId: string, templateId: string, approval?: TemplateApproval): Promise<TemplateActionResult<{ proposalId: string; title: string }>> {
  const parsed = z.object({ channelId: Id, templateId: TemplateId, approval: Approval.optional() }).safeParse({ channelId, templateId, approval });
  if (!parsed.success) return { ok: false, message: 'Unknown template' };
  const refusal = await denied(Permission.MESSAGE_TEMPLATES_DELETE);
  if (refusal) return { ok: false, message: refusal };
  try {
    const i = parsed.data;
    const res = await api.delete(`/v1/channels/${enc(i.channelId)}/templates/${enc(i.templateId)}`, i.approval ? { approval: i.approval } : {}, Proposal, { timeoutMs: 30_000 });
    refresh();
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

/**
 * A template made in the provider's console has no OCSO record: asking to delete it records one (origin
 * provider) so a deletion proposal has an object. Returns that record's id for the submit-for-approval modal.
 */
export async function recordTemplateForDeletionAction(channelId: string, templateId: string): Promise<TemplateActionResult<{ recordId: string }>> {
  const parsed = z.object({ channelId: Id, templateId: TemplateId }).safeParse({ channelId, templateId });
  if (!parsed.success) return { ok: false, message: 'Unknown template' };
  const refusal = await denied(Permission.MESSAGE_TEMPLATES_DELETE);
  if (refusal) return { ok: false, message: refusal };
  const base = `/v1/channels/${enc(parsed.data.channelId)}/templates/${enc(parsed.data.templateId)}`;
  try {
    await api.delete(base, {}, Proposal);
    return { ok: false, message: 'Unexpected answer: the deletion needs a checker' };
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'approval_required') return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
  try {
    const view = await api.get(base, TemplateViewSchema);
    return view.submission ? { ok: true, data: { recordId: view.submission.recordId } } : { ok: false, message: 'The template could not be recorded for deletion' };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}
