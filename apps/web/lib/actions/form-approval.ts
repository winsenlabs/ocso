import { z } from 'zod';
import { APPROVAL_CHECKER_FIELD, APPROVAL_REASON_FIELD, APPROVAL_SELF } from '@/components/settings/lib/settings-approval';
import { ProposedSchema } from '@/components/approvals/lib/schemas';
import type { FormState } from './form-state';

/**
 * Settings changes are always proposals (PM/research/11 §4): every settings form names a checker and a
 * reason (SettingsApprovalFields). Server-side helpers for the form actions (not server actions themselves).
 */
export type FormApproval = { checkerId: string; reason: string } | { bootstrap: true; reason: string };

/** The approval the form carries, or a field error. */
export function approvalFromForm(formData: FormData): { ok: true; approval: FormApproval } | { ok: false; state: FormState } {
  const checker = String(formData.get(APPROVAL_CHECKER_FIELD) ?? '');
  const reason = String(formData.get(APPROVAL_REASON_FIELD) ?? '').trim();
  const errors: Record<string, string> = {};
  if (!checker) errors[APPROVAL_CHECKER_FIELD] = 'Choose who approves this change';
  else if (checker !== APPROVAL_SELF && !z.uuid().safeParse(checker).success) errors[APPROVAL_CHECKER_FIELD] = 'Choose who approves this change';
  if (reason.length < 3) errors[APPROVAL_REASON_FIELD] = 'Give a reason of at least 3 characters';
  if (Object.keys(errors).length) return { ok: false, state: { status: 'error', fieldErrors: errors, message: 'Settings change through an approval: name a checker and give a reason.' } };
  return { ok: true, approval: checker === APPROVAL_SELF ? { bootstrap: true, reason } : { checkerId: checker, reason } };
}

/** What the form says after the API answered: 202 → sent for approval; otherwise applied (bootstrap). */
export function outcomeMessage(res: unknown, applied: string): FormState {
  const proposed = ProposedSchema.safeParse(res);
  if (proposed.success && proposed.data.proposal.status === 'SUBMITTED') {
    return { status: 'success', message: `Sent for approval to ${proposed.data.proposal.checker?.name ?? 'the checker'} · nothing changes until it is approved` };
  }
  return { status: 'success', message: applied };
}
