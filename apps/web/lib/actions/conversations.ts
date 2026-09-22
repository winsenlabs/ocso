'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';
import { api } from '../api/client';
import { CopilotSuggestionSchema, type CopilotSuggestion } from '../api/conversations';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';

/**
 * Human operations from the CS workspace (design/01, docs/09 §4). The API
 * authorizes every call; these actions validate input, forward it with the
 * session token and refresh the page so the timeline shows the result.
 */

export type ActionResult = { ok: true } | { ok: false; message: string; code?: string };

const Id = z.uuid();
const path = (id: string) => `/v1/conversations/${encodeURIComponent(id)}`;

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.', code: 'unauthenticated' };
  try {
    await fn();
  } catch (err) {
    return failure(err);
  }
  refresh();
  return { ok: true };
}

function failure(err: unknown): { ok: false; message: string; code?: string } {
  return err instanceof ApiError ? { ok: false, message: err.message, code: err.code } : { ok: false, message: describeApiError(err) };
}

const invalid = (message: string): ActionResult => ({ ok: false, message, code: 'validation' });

type ControlCommand = 'claim' | 'accept' | 'decline' | 'take-over' | 'cancel-return' | 'reopen';
const COMMANDS: readonly ControlCommand[] = ['claim', 'accept', 'decline', 'take-over', 'cancel-return', 'reopen'];

/** Claim / Accept / Decline offer / Take over / Cancel return / Reopen (body-less commands). */
export async function controlAction(conversationId: string, command: ControlCommand): Promise<ActionResult> {
  if (!Id.safeParse(conversationId).success || !COMMANDS.includes(command)) return invalid('Unknown conversation action');
  return run(() => api.command('POST', `${path(conversationId)}/${command}`));
}

const ReturnInput = z.object({ handoverSummary: z.string().trim().min(1, 'Write a short handover summary for the agent').max(4_000) });

export async function returnToAiAction(conversationId: string, handoverSummary: string): Promise<ActionResult> {
  const parsed = ReturnInput.safeParse({ handoverSummary });
  if (!Id.safeParse(conversationId).success) return invalid('Unknown conversation');
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid summary');
  return run(() => api.command('POST', `${path(conversationId)}/return-to-ai`, parsed.data));
}

const ResolveInput = z.object({ disposition: z.string().trim().max(200, 'At most 200 characters') });

export async function resolveAction(conversationId: string, disposition: string): Promise<ActionResult> {
  const parsed = ResolveInput.safeParse({ disposition });
  if (!Id.safeParse(conversationId).success) return invalid('Unknown conversation');
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid disposition');
  const body = parsed.data.disposition ? { disposition: parsed.data.disposition } : {};
  return run(() => api.command('POST', `${path(conversationId)}/resolve`, body));
}

const TransferInput = z.object({ queueId: z.uuid().optional(), userId: z.uuid().optional() }).refine((v) => v.queueId || v.userId, 'Choose a queue or a person');

export async function transferAction(conversationId: string, target: { queueId?: string; userId?: string }): Promise<ActionResult> {
  const parsed = TransferInput.safeParse(target);
  if (!Id.safeParse(conversationId).success) return invalid('Unknown conversation');
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Choose a queue or a person');
  return run(() => api.command('POST', `${path(conversationId)}/transfer`, parsed.data));
}

const NoteInput = z.object({ body: z.string().trim().min(1, 'Write the note first').max(8_000, 'At most 8,000 characters'), passToAgent: z.boolean() });

/** Internal note — staff only, never sent to the customer (docs/09 §5). */
export async function addNoteAction(conversationId: string, body: string, passToAgent: boolean): Promise<ActionResult> {
  const parsed = NoteInput.safeParse({ body, passToAgent });
  if (!Id.safeParse(conversationId).success) return invalid('Unknown conversation');
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid note');
  return run(() => api.post(`${path(conversationId)}/notes`, parsed.data, z.object({ id: z.string() })));
}

const ReplyInput = z.object({ text: z.string().trim().min(1, 'Write a reply first').max(32_000), clientMessageId: z.string().min(8).max(100) });

/** Customer-visible reply; the API accepts it only while this human holds the conversation. */
export async function sendReplyAction(conversationId: string, text: string, clientMessageId: string): Promise<ActionResult> {
  const parsed = ReplyInput.safeParse({ text, clientMessageId });
  if (!Id.safeParse(conversationId).success) return invalid('Unknown conversation');
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Invalid reply');
  return run(() =>
    api.post(`${path(conversationId)}/messages`, { clientMessageId: parsed.data.clientMessageId, parts: [{ type: 'TEXT', text: parsed.data.text }] }, z.object({ interactionId: z.string() })),
  );
}

export type ToolRunResult = { ok: true; status: 'SUCCEEDED' | 'FAILED'; detail: string | null } | { ok: false; message: string; code?: string };

const RunInput = z.object({ toolId: z.uuid(), args: z.record(z.string(), z.unknown()), confirmed: z.boolean() });
const RunResponse = z.object({ status: z.enum(['SUCCEEDED', 'FAILED']), error: z.string().optional() });

/** Composer "Tool action": run an approved tool as this human; sensitive tools need confirmed=true. */
export async function runToolAction(conversationId: string, toolId: string, args: Record<string, unknown>, confirmed: boolean): Promise<ToolRunResult> {
  const parsed = RunInput.safeParse({ toolId, args, confirmed });
  if (!Id.safeParse(conversationId).success || !parsed.success) return { ok: false, message: 'Invalid tool request', code: 'validation' };
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    const res = await api.post(`${path(conversationId)}/tools/run`, parsed.data, RunResponse, { timeoutMs: 40_000 });
    refresh();
    return { ok: true, status: res.status, detail: res.error ?? null };
  } catch (err) {
    return failure(err);
  }
}

/** "Confirm and run" on a sensitive action the agent proposed (docs/08 §7). */
export async function confirmToolCallAction(toolCallId: string): Promise<ActionResult> {
  if (!Id.safeParse(toolCallId).success) return invalid('Unknown tool call');
  return run(() => api.post(`/v1/tool-calls/${encodeURIComponent(toolCallId)}/confirm`, {}, z.unknown(), { timeoutMs: 40_000 }));
}

const DenyInput = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500) });

export async function denyToolCallAction(toolCallId: string, reason: string): Promise<ActionResult> {
  const parsed = DenyInput.safeParse({ reason });
  if (!Id.safeParse(toolCallId).success) return invalid('Unknown tool call');
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? 'Give a reason');
  return run(() => api.command('POST', `/v1/tool-calls/${encodeURIComponent(toolCallId)}/deny`, parsed.data));
}

export type CopilotDraftResult = { ok: true; suggestion: CopilotSuggestion } | { ok: false; hidden: boolean; message: string };

const DraftInput = z.object({ style: z.enum(['default', 'shorter', 'warmer', 'formal']), baseText: z.string().max(4_000).optional() });

/** Ask the copilot for a draft. 404/403/400/409 → hide the block rather than show an error. */
export async function copilotDraftAction(conversationId: string, style: string, baseText?: string): Promise<CopilotDraftResult> {
  const parsed = DraftInput.safeParse({ style, ...(baseText ? { baseText } : {}) });
  if (!Id.safeParse(conversationId).success || !parsed.success) return { ok: false, hidden: false, message: 'Invalid draft request' };
  if (!(await getSession())) return { ok: false, hidden: false, message: 'Your session has ended. Sign in again.' };
  try {
    const suggestion = await api.post(`${path(conversationId)}/copilot/draft`, parsed.data, CopilotSuggestionSchema, { timeoutMs: 60_000 });
    return { ok: true, suggestion };
  } catch (err) {
    const hidden = err instanceof ApiError && [400, 403, 404, 409].includes(err.status);
    return { ok: false, hidden, message: describeApiError(err) };
  }
}

export async function copilotOutcomeAction(suggestionId: string, outcome: 'INSERTED' | 'DISMISSED'): Promise<ActionResult> {
  if (!Id.safeParse(suggestionId).success || !['INSERTED', 'DISMISSED'].includes(outcome)) return invalid('Unknown suggestion');
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    await api.command('POST', `/v1/copilot-suggestions/${encodeURIComponent(suggestionId)}/outcome`, { outcome });
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
