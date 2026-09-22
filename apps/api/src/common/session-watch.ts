import { Observable, filter, from, interval, mergeMap, take } from 'rxjs';
import type { SessionLiveness } from '@ocso/application';

/**
 * Emits once when a long-lived stream's session stops being valid (revoked,
 * expired, idle, user disabled, MFA policy unmet). Checked every `everyMs`;
 * a stream without a session id ends at the first check.
 */
export function endsWhenSessionEnds(liveness: SessionLiveness, sessionId: string | undefined, everyMs: number): Observable<unknown> {
  return interval(everyMs).pipe(
    mergeMap(() => from(sessionId ? liveness.isLive(sessionId).catch(() => false) : Promise.resolve(false))),
    filter((live) => !live),
    take(1),
  );
}

/** AbortSignal flavour for handlers that stream by hand (Ask OCSO). */
export function abortWhenSessionEnds(liveness: SessionLiveness, sessionId: string | undefined, everyMs: number, abort: AbortController): () => void {
  const subscription = endsWhenSessionEnds(liveness, sessionId, everyMs).subscribe(() => abort.abort(new Error('session ended')));
  return () => subscription.unsubscribe();
}
