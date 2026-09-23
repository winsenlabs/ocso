'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import type { MiniTableData, ObjectLink } from '@/components/internal-agent/types';
import { ApiError, describeApiError } from '../api/errors';
import { confirmInternalAgentAction, rejectInternalAgentAction, setInternalAgentProfile } from '../api/internal-agent';
import { getSession } from '../session';

/** Outcome of Confirm / Reject on an Ask OCSO action card. */
export type ActionDecision =
  | { ok: true; status: 'EXECUTED'; links: ObjectLink[]; table: MiniTableData | null }
  | { ok: true; status: 'REJECTED' }
  | { ok: false; message: string; settled: 'EXPIRED' | 'DECIDED' | null };

const ActionId = z.uuid();

function failure(err: unknown): ActionDecision {
  if (err instanceof ApiError) {
    if (err.code === 'action_not_pending') return { ok: false, message: `${err.message}.`, settled: 'DECIDED' };
    if (err.isForbidden && /expired/i.test(err.message)) return { ok: false, message: 'The confirmation window has expired. Ask OCSO again to propose it anew.', settled: 'EXPIRED' };
    if (err.isForbidden) return { ok: false, message: `Not allowed for your role: ${err.message}`, settled: null };
    if (err.isUnauthenticated) return { ok: false, message: 'Your session has ended. Sign in again.', settled: null };
  }
  return { ok: false, message: describeApiError(err), settled: null };
}

/**
 * POST /v1/internal-agent/actions/:id/confirm. The API re-checks the user's
 * permission, executes through the same service the UI uses and audits it
 * (via = INTERNAL_AGENT). The current page is refreshed so it shows the change.
 */
export async function confirmAskOcsoAction(actionId: string): Promise<ActionDecision> {
  const id = ActionId.safeParse(actionId);
  if (!id.success) return { ok: false, message: 'Unknown action.', settled: null };
  try {
    const result = await confirmInternalAgentAction(id.data);
    refresh();
    return { ok: true, status: 'EXECUTED', links: result.links ?? [], table: result.table ?? null };
  } catch (err) {
    return failure(err);
  }
}

/** POST /v1/internal-agent/actions/:id/reject — nothing changes; the rejection is audited. */
export async function rejectAskOcsoAction(actionId: string): Promise<ActionDecision> {
  const id = ActionId.safeParse(actionId);
  if (!id.success) return { ok: false, message: 'Unknown action.', settled: null };
  try {
    await rejectInternalAgentAction(id.data);
    return { ok: true, status: 'REJECTED' };
  } catch (err) {
    return failure(err);
  }
}

export type ProfileChoice = { ok: true } | { ok: false; message: string };

/** Tech Admin: choose the model profile Ask OCSO runs on (deployment setting, audited by the API). */
export async function chooseAskOcsoProfile(profileId: string): Promise<ProfileChoice> {
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (!session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE)) {
    return { ok: false, message: 'Only a Platform Tech Admin can choose the model for Ask OCSO.' };
  }
  const id = ActionId.safeParse(profileId);
  if (!id.success) return { ok: false, message: 'Choose a model profile.' };
  try {
    await setInternalAgentProfile(id.data);
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
  refresh();
  return { ok: true };
}
