import { Observable, filter, from, interval, mergeMap, take } from 'rxjs';
import type { HeldRights, SessionLiveness } from '@ocso/application';

/**
 * Emits once when a long-lived stream's session stops being valid (revoked,
 * expired, idle, user disabled, MFA policy unmet) or, given `held` (the
 * principal the stream was opened with), when the user lost a permission or a
 * team since. Checked every `everyMs`; a stream without a session id ends at
 * the first check.
 */
export function endsWhenSessionEnds(liveness: SessionLiveness, sessionId: string | undefined, everyMs: number, held?: HeldRights): Observable<unknown> {
  return interval(everyMs).pipe(
    mergeMap(() => from(sessionId ? liveness.isLive(sessionId, new Date(), held).catch(() => false) : Promise.resolve(false))),
    filter((live) => !live),
    take(1),
  );
}

/** AbortSignal flavour for handlers that stream by hand (Ask OCSO). */
export function abortWhenSessionEnds(liveness: SessionLiveness, sessionId: string | undefined, everyMs: number, abort: AbortController, held?: HeldRights): () => void {
  const subscription = endsWhenSessionEnds(liveness, sessionId, everyMs, held).subscribe(() => abort.abort(new Error('session ended')));
  return () => subscription.unsubscribe();
}
