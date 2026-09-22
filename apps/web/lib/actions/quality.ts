'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { parseCorrectionForm, parseReviewForm } from '@/components/quality/forms';
import { describeApiError } from '../api/errors';
import { createCorrection, createReview, rejectCorrection, stageCorrection, type CorrectionRequest } from '../api/quality';
import { getSession } from '../session';
import { field, type FormState } from './form-state';

export type QualityResult = { ok: true; message: string } | { ok: false; message: string };

async function guard(permissions: readonly Permission[], what: string): Promise<string | null> {
  const session = await getSession();
  if (!session) redirect('/login');
  return permissions.every((p) => session.permissions.has(p)) ? null : `Your role cannot ${what}.`;
}

function fields(formData: FormData, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, field(formData, n)]));
}

/** POST /v1/reviews (reviews.manage): rubric scores 1–5, outcome tag, notes. */
export async function createReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ['conversationId', 'accuracy', 'policy', 'tone', 'resolution', 'outcomeTag', 'notes']);
  const parsed = parseReviewForm(values);
  if (!parsed.ok) return { status: 'error', fieldErrors: parsed.fieldErrors, values };
  const denied = await guard([Permission.REVIEWS_MANAGE], 'review conversations');
  if (denied) return { status: 'error', message: denied, values };
  try {
    const review = await createReview(parsed.data);
    refresh();
    return { status: 'success', message: `Reviewed ${review.displayId} · score ${review.score.toFixed(2)}` };
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
}

/** POST /v1/corrections (corrections.manage). A same-title open correction is merged by the API. */
export async function createCorrectionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ['agentId', 'conversationId', 'interactionSeq', 'title', 'observed', 'desired', 'componentKey', 'proposedText']);
  const parsed = parseCorrectionForm(values);
  if (!parsed.ok) return { status: 'error', fieldErrors: parsed.fieldErrors, values };
  const denied = await guard([Permission.CORRECTIONS_MANAGE], 'record prompt corrections');
  if (denied) return { status: 'error', message: denied, values };
  const d = parsed.data;
  const request: CorrectionRequest = {
    observed: d.observed,
    desired: d.desired,
    componentKey: d.componentKey,
    ...(d.agentId ? { agentId: d.agentId } : {}),
    ...(d.conversationId ? { conversationId: d.conversationId } : {}),
    ...(d.interactionSeq !== undefined ? { interactionSeq: d.interactionSeq } : {}),
    ...(d.title ? { title: d.title } : {}),
    ...(d.proposedText ? { proposedText: d.proposedText } : {}),
  };
  try {
    const res = await createCorrection(request);
    refresh();
    return { status: 'success', message: res.merged ? 'Merged into an open correction with the same title (observed again)' : 'Correction recorded' };
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
}

const Id = z.uuid();
const Stage = z.object({ proposedText: z.string().trim().max(20_000), mode: z.enum(['APPEND', 'REPLACE']) });

/** POST /v1/corrections/:id/stage — writes into the agent's prompt DRAFT, never the live prompt (corrections.manage + prompts.edit). */
export async function stageCorrectionAction(id: string, input: { proposedText: string; mode: 'APPEND' | 'REPLACE' }): Promise<QualityResult> {
  const parsed = Stage.safeParse(input);
  if (!Id.safeParse(id).success || !parsed.success) return { ok: false, message: 'Enter the text to stage (at most 20000 characters).' };
  const denied = await guard([Permission.CORRECTIONS_MANAGE, Permission.PROMPTS_EDIT], 'stage corrections into a prompt draft');
  if (denied) return { ok: false, message: denied };
  try {
    const res = await stageCorrection(id, { mode: parsed.data.mode, ...(parsed.data.proposedText ? { proposedText: parsed.data.proposedText } : {}) });
    refresh();
    return { ok: true, message: res.changed ? `Staged into the ${res.componentKey} draft` : `Already in the ${res.componentKey} draft — marked staged` };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}

/** POST /v1/corrections/:id/reject (corrections.manage). */
export async function rejectCorrectionAction(id: string, reason: string): Promise<QualityResult> {
  if (!Id.safeParse(id).success || reason.length > 500) return { ok: false, message: 'Reasons are at most 500 characters.' };
  const denied = await guard([Permission.CORRECTIONS_MANAGE], 'reject corrections');
  if (denied) return { ok: false, message: denied };
  try {
    await rejectCorrection(id, reason.trim() || undefined);
    refresh();
    return { ok: true, message: 'Correction rejected' };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}
