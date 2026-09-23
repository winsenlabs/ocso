'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { afterTimeout, decisionFailure, fromAnswer, isTimeout, type ActionDecision, type CardStatusRead } from '@/components/internal-agent/decisions';
import { ApiError, describeApiError } from '../api/errors';
import { confirmInternalAgentAction, getInternalAgentAction, rejectInternalAgentAction, setInternalAgentProfile } from '../api/internal-agent';
import { getSession } from '../session';

export type { ActionDecision } from '@/components/internal-agent/decisions';

const ActionId = z.uuid();
const ConfirmSchema = z.object({
  checkerId: z.uuid('Choose who approves this.').optional(),
  reason: z.string().trim().min(3, 'Give a reason of at least 3 characters.').max(500, 'Keep the reason under 500 characters.').optional(),
});

/**
 * POST /v1/internal-agent/actions/:id/confirm. The API re-checks the card and the user's permission, then runs
 * the real route as them: it applies (direct, stop) or goes to the chosen checker (governed; `checkerId` + `reason`).
 * The current page is refreshed so it shows the change.
 */
export async function confirmAskOcsoAction(actionId: string, input: { checkerId?: string; reason?: string } = {}): Promise<ActionDecision> {
  const id = ActionId.safeParse(actionId);
  if (!id.success) return { ok: false, message: 'Unknown action.', settled: null };
  const parsed = ConfirmSchema.safeParse({ ...(input.checkerId ? { checkerId: input.checkerId } : {}), ...(input.reason?.trim() ? { reason: input.reason } : {}) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue?.message ?? 'Check the approval details.', settled: null, field: issue?.path[0] === 'checkerId' ? 'checkerId' : 'reason' };
  }
  try {
    const answer = await confirmInternalAgentAction(id.data, parsed.data);
    refresh();
    return fromAnswer(answer, 'EXECUTED');
  } catch (err) {
    if (!isTimeout(err)) return decisionFailure(err);
    // The API may still be applying it: show where the card really stands, never "failed".
    const decision = afterTimeout(await readCard(id.data));
    if (decision.ok) refresh();
    return decision;
  }
}

/** The card as it stands now, or null when it cannot be read. */
async function readCard(actionId: string): Promise<CardStatusRead> {
  try {
    return await getInternalAgentAction(actionId);
  } catch {
    return null;
  }
}

/**
 * Re-read a card whose outcome is not known yet (UNKNOWN in the drawer). Answers the settled card once OCSO
 * knows, or null while the confirm is still running or the card cannot be read.
 */
export async function checkAskOcsoAction(actionId: string): Promise<ActionDecision | null> {
  const id = ActionId.safeParse(actionId);
  if (!id.success) return null;
  const decision = afterTimeout(await readCard(id.data));
  if (!decision.ok) return null;
  refresh();
  return decision;
}

/** POST /v1/internal-agent/actions/:id/reject — nothing changes; the cancellation is audited. */
export async function rejectAskOcsoAction(actionId: string): Promise<ActionDecision> {
  const id = ActionId.safeParse(actionId);
  if (!id.success) return { ok: false, message: 'Unknown action.', settled: null };
  try {
    return fromAnswer(await rejectInternalAgentAction(id.data), 'REJECTED');
  } catch (err) {
    if (!isTimeout(err)) return decisionFailure(err);
    const read = await readCard(id.data);
    if (read && !read.running && read.card.status !== 'PENDING') return { ok: true, card: read.card };
    return { ok: false, message: 'OCSO did not answer in time. Try Cancel again.', settled: null };
  }
}

export type ProfileChoice = { ok: true; data: { proposed: boolean } } | { ok: false; message: string; code?: string | undefined };

const SettingsApproval = z.union([z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);

/**
 * Tech admin: choose the model profile Ask OCSO runs on. It is a deployment setting, so the change is a
 * proposal a second person approves (PM/research/11 §4): without `approval` the API answers approval_required.
 */
export async function chooseAskOcsoProfile(profileId: string, approval?: z.input<typeof SettingsApproval>): Promise<ProfileChoice> {
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE)) {
    return { ok: false, message: 'Only a Tech admin can choose the model for Ask OCSO.' };
  }
  const id = ActionId.safeParse(profileId);
  if (!id.success) return { ok: false, message: 'Choose a model profile.' };
  const choice = approval === undefined ? undefined : SettingsApproval.safeParse(approval);
  if (choice && !choice.success) return { ok: false, message: choice.error.issues.map((i) => i.message).join('; ') };
  let proposed = false;
  try {
    proposed = await setInternalAgentProfile(id.data, choice?.success ? choice.data : undefined);
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
  refresh();
  return { ok: true, data: { proposed } };
}
