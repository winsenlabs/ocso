/**
 * Ask OCSO's time bounds for delegated calls, in a module of their own so the web BFF's tests can hold its
 * confirm wait above them.
 */

/** A delegated read that takes longer than this is abandoned: nothing changed, so it can fail plainly. */
export const READ_TIMEOUT_MS = 30_000;
/**
 * A confirmed write waits this long for its route. Aborting the request does not stop the route (Express keeps
 * running the handler), so the bound is above every UI budget for the same routes (copilot drafts get 60s) and a
 * write that still runs past it is answered as "outcome unknown", never as "it could not be run".
 */
export const WRITE_TIMEOUT_MS = 90_000;
/** The error code a write past WRITE_TIMEOUT_MS answers with: it may or may not have applied. */
export const OUTCOME_UNKNOWN_CODE = 'outcome_unknown';

/** The API's own bound for one confirm: the card's snapshot read, then the write. The web BFF waits longer. */
export const CONFIRM_BOUND_MS = READ_TIMEOUT_MS + WRITE_TIMEOUT_MS;
