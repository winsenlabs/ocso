import { ApiError, describeApiError } from '../../lib/api/errors';
import { z } from 'zod';
import { ActionCardSchema, MiniTableSchema, ObjectLinkSchema, type ActionCardData, type MiniTableData, type ObjectLink } from './types';

/**
 * Outcome of Confirm / Cancel on an Ask OCSO card. `card` is the API's word on where the card stands now
 * (EXECUTED / SUBMITTED / REJECTED / STALE / …, with its result); an older API answered with the tool's links.
 */
export type ActionDecision =
  | { ok: true; card: ActionCardData }
  | { ok: true; status: 'EXECUTED'; links: ObjectLink[]; table: MiniTableData | null }
  | { ok: true; status: 'REJECTED' }
  | { ok: false; message: string; settled: 'EXPIRED' | 'STALE' | 'DECIDED' | 'UNKNOWN' | null; field?: 'checkerId' | 'reason' | undefined };

/**
 * The confirm / reject endpoint's answer: the card, the older `{ links, table }` (confirm only), nothing (204),
 * or a body this page cannot read (`unreadable`), which is never reported as applied.
 */
export type ActionAnswer =
  | { card: ActionCardData }
  | { legacy: { links?: ObjectLink[] | undefined; table?: MiniTableData | undefined } }
  | { card: null }
  | { unreadable: true };

/**
 * How long the BFF waits for confirm / reject. The API bounds one confirm at 120 s (a 30 s snapshot read, then
 * a 90 s write: apps/api loopback-runner CONFIRM_BOUND_MS); this waits past that, and a confirm that still
 * outlives it is re-read rather than reported as failed.
 */
export const CARD_DECISION_TIMEOUT_MS = 135_000;

/** The API's words for "this may or may not have applied" (a write past its bound, a confirm that never finished). */
const OUTCOME_UNKNOWN_TEXT = /may or may not have applied/i;

export const UNKNOWN_MESSAGE = 'OCSO has not confirmed whether this applied yet. Check the object before asking again; this card updates when OCSO knows.';

/**
 * The card as the drawer should show it. A card the runtime settled FAILED with a "may or may not have applied"
 * result is not a failure: it is UNKNOWN, rendered with a link to check the object.
 */
export function honestCard(card: ActionCardData): ActionCardData {
  if (card.status === 'FAILED' && card.result && OUTCOME_UNKNOWN_TEXT.test(card.result.message)) return { ...card, status: 'UNKNOWN' };
  return card;
}

/** GET /v1/internal-agent/actions/:id: the card now, and whether a confirm is still running on it. */
export type CardStatusRead = { card: ActionCardData; running: boolean } | null;

export function readCardStatus(body: unknown): CardStatusRead {
  const card = ActionCardSchema.safeParse(body);
  if (!card.success) return null;
  const running = typeof body === 'object' && body !== null && (body as { running?: unknown }).running === true;
  return { card: honestCard(card.data), running };
}

/**
 * After a confirm outlived the BFF's wait: the card as re-read. A settled card is taken at its word; a card whose
 * confirm is still running (or that cannot be read) is UNKNOWN, never FAILED, because the change may still apply.
 */
export function afterTimeout(read: CardStatusRead): ActionDecision {
  if (read && !read.running && read.card.status !== 'PENDING') return { ok: true, card: read.card };
  return { ok: false, message: UNKNOWN_MESSAGE, settled: 'UNKNOWN' };
}

/** Whether an API error means the request outlived its wait (the API may still be working on it). */
export function isTimeout(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'api_timeout' || err.category === 'timeout');
}

/** What a confirmed legacy proposal did (before cards): the tool's links / table. */
const LegacyResultSchema = z.object({ links: z.array(ObjectLinkSchema).optional(), table: MiniTableSchema.optional() });

/**
 * Read the confirm / reject body. Only an empty body (204) or a valid card is taken at its word. The older
 * `{ links, table }` answer counts only for confirm and only when it actually carries links or a table; anything
 * else is `unreadable`, so a card that misses the schema (a new status, a null field) never shows as applied.
 */
export function readActionAnswer(body: unknown, endpoint: 'confirm' | 'reject'): ActionAnswer {
  if (body === undefined || body === null || body === '') return { card: null };
  const card = ActionCardSchema.safeParse(body);
  if (card.success) return { card: honestCard(card.data) };
  if (endpoint === 'confirm' && typeof body === 'object' && !Array.isArray(body) && ('links' in body || 'table' in body) && !('status' in body) && !('kind' in body)) {
    const legacy = LegacyResultSchema.safeParse(body);
    if (legacy.success && (legacy.data.links !== undefined || legacy.data.table !== undefined)) return { legacy: legacy.data };
  }
  return { unreadable: true };
}

/** An API refusal in words the card can act on: settled ones remove the buttons. */
export function decisionFailure(err: unknown): ActionDecision {
  if (err instanceof ApiError) {
    if (err.code === 'action_not_pending' || err.code === 'action_outdated') return { ok: false, message: `${err.message.replace(/\.$/, '')}.`, settled: 'DECIDED' };
    if (err.code === 'checker_required' || err.code === 'checker_not_eligible') return { ok: false, message: err.message, settled: null, field: 'checkerId' };
    if (err.code === 'reason_required') return { ok: false, message: err.message, settled: null, field: 'reason' };
    if (err.code === 'action_stale' || err.code === 'content_changed' || /changed since|\bstale\b/i.test(err.message)) {
      return { ok: false, message: 'This changed since the card was made, so nothing was done. Ask again for a fresh card.', settled: 'STALE' };
    }
    if (err.code === 'action_expired' || /expired/i.test(err.message)) {
      return { ok: false, message: 'The confirmation window has expired. Ask OCSO again to propose it anew.', settled: 'EXPIRED' };
    }
    if (err.code === 'ask_ocso_writes_off' || err.code === 'ask_ocso_writes_disabled') {
      return { ok: false, message: 'Changes through Ask OCSO are turned off for this deployment. Make the change on its page instead.', settled: null };
    }
    if (err.isForbidden) return { ok: false, message: `Not allowed for your role: ${err.message}`, settled: null };
    if (err.isUnauthenticated) return { ok: false, message: 'Your session has ended. Sign in again.', settled: null };
  }
  return { ok: false, message: describeApiError(err), settled: null };
}

export function fromAnswer(answer: ActionAnswer, fallback: 'EXECUTED' | 'REJECTED'): ActionDecision {
  if ('unreadable' in answer) {
    return { ok: false, message: 'OCSO took the decision but this page could not read the result. Open the thread again to see where it stands.', settled: 'DECIDED' };
  }
  if ('legacy' in answer) return { ok: true, status: 'EXECUTED', links: answer.legacy.links ?? [], table: answer.legacy.table ?? null };
  if (answer.card) return { ok: true, card: answer.card };
  return fallback === 'REJECTED' ? { ok: true, status: 'REJECTED' } : { ok: true, status: 'EXECUTED', links: [], table: null };
}
