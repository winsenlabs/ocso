/**
 * The "take next" loop, pure for the action and its tests. The API names the
 * one conversation this member can claim (`service.next`: unassigned,
 * WAITING_FOR_HUMAN, in their queues); a 409/404 means someone took it first,
 * so read Home again (fresh) and try the new `next`, a few times at most.
 */
export type ClaimOutcome = { ok: true } | { ok: false; retry: boolean; error: unknown };
export type TakeNextLoopResult = { ok: true; conversationId: string } | { ok: false; reason: 'empty' | 'conflict' | 'error'; error?: unknown };

export async function claimNext(loadNext: (attempt: number) => Promise<string | null>, claim: (conversationId: string) => Promise<ClaimOutcome>, attempts = 3): Promise<TakeNextLoopResult> {
  let conflicted = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const id = await loadNext(attempt);
    if (!id) return conflicted ? { ok: false, reason: 'conflict' } : { ok: false, reason: 'empty' };
    const res = await claim(id);
    if (res.ok) return { ok: true, conversationId: id };
    if (!res.retry) return { ok: false, reason: 'error', error: res.error };
    conflicted = true;
  }
  return { ok: false, reason: 'conflict' };
}
