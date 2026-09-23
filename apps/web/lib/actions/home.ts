'use server';

import { api } from '../api/client';
import { ApiError, describeApiError } from '../api/errors';
import { loadHome } from '../api/home';
import { getSession } from '../session';
import { claimNext } from './take-next-order';

export type TakeNextResult = { ok: true; conversationId: string } | { ok: false; message: string; code?: string };

/** Claims tried before giving up: another member may claim the same conversation first (409). */
const ATTEMPTS = 3;

/**
 * "Take next" on the Service Home (HOME decision 3): claim the conversation
 * the API names as `service.next` (unassigned and waiting in this member's
 * queues), reading Home fresh each time so a conflict moves on to the new next.
 * The API authorizes and serializes every claim.
 */
export async function takeNextAction(): Promise<TakeNextResult> {
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.', code: 'unauthenticated' };
  try {
    const res = await claimNext(
      async () => {
        const home = await loadHome({ headers: { 'cache-control': 'no-cache' } });
        return home.role === 'SERVICE' ? (home.service?.next?.conversationId ?? null) : null;
      },
      async (id) => {
        try {
          await api.command('POST', `/v1/conversations/${encodeURIComponent(id)}/claim`);
          return { ok: true };
        } catch (err) {
          // Someone else took it (or it moved on): read the next one. Anything else is a real failure.
          return { ok: false, retry: err instanceof ApiError && (err.status === 409 || err.status === 404), error: err };
        }
      },
      ATTEMPTS,
    );
    if (res.ok) return res;
    if (res.reason === 'empty') return { ok: false, message: 'Nobody is waiting in your queues right now.', code: 'empty' };
    if (res.reason === 'conflict') return { ok: false, message: 'Those conversations were just claimed by someone else. Try again.', code: 'conflict' };
    return failure(res.error);
  } catch (err) {
    return failure(err);
  }
}

function failure(err: unknown): { ok: false; message: string; code?: string } {
  return err instanceof ApiError ? { ok: false, message: err.message, code: err.code } : { ok: false, message: describeApiError(err) };
}
