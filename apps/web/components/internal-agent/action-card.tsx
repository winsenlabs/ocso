'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { confirmAskOcsoAction, rejectAskOcsoAction } from '../../lib/actions/internal-agent';
import { honestCard, UNKNOWN_MESSAGE, type ActionDecision } from './decisions';
import { LinkCards, MiniTable, safeHref } from './parts';
import { useReconcileUnknown } from './use-reconcile-unknown';
import { toActionCard, type ActionCardData, type ActionPart, type ActionStatus } from './types';

/**
 * A write the agent wants to make (PM/research/12 §5, design/05 `.confirm`). The server built this card;
 * nothing changes until this user clicks. Direct and stop cards apply on confirm; a governed card asks
 * who approves it and why, and confirming submits the proposal to that checker. Bootstrap self-approval
 * is never offered here: when nobody else can approve, the card sends the user to the page instead.
 */

type Kind = ActionCardData['kind'];

const KIND: Record<Kind, { badge: string; tone: string; heading: string; confirm: string; working: string }> = {
  direct: { badge: 'Applies now', tone: 'accent', heading: 'confirm change', confirm: 'Confirm change', working: 'Applying…' },
  stop: { badge: 'Stop', tone: 'warn', heading: 'confirm stop', confirm: 'Confirm stop', working: 'Stopping…' },
  governed: { badge: 'Needs approval', tone: 'warn', heading: 'request approval', confirm: 'Send for approval', working: 'Sending…' },
};

const OUTCOME: Record<Exclude<ActionStatus, 'PENDING'>, { chip: string; tone: string; text: string }> = {
  EXECUTED: { chip: 'done', tone: 'good', text: 'Applied. The change is recorded in the audit log under your name.' },
  SUBMITTED: { chip: 'sent for approval', tone: 'accent', text: 'Sent for approval. Nothing changes until the checker approves it.' },
  REJECTED: { chip: 'cancelled', tone: 'muted', text: 'Cancelled. Nothing was changed.' },
  EXPIRED: { chip: 'expired', tone: 'muted', text: 'Not confirmed in time, so nothing was changed. Ask again to get a fresh card.' },
  FAILED: { chip: 'failed', tone: 'danger', text: 'It could not be done, so nothing was changed.' },
  STALE: { chip: 'out of date', tone: 'warn', text: 'This changed since the card was made, so nothing was done. Ask again for a fresh card.' },
  UNKNOWN: { chip: 'outcome unknown', tone: 'warn', text: UNKNOWN_MESSAGE },
};

/** "HEAD" → "Head"; a label the API already cased stays as it is. */
const roleLabel = (role: string) => (role === role.toUpperCase() ? role.charAt(0) + role.slice(1).toLowerCase() : role);

/** The runtime's warning for a governed card with no eligible checker (packages/internal-agent runtime/cards.ts). */
const NOBODY_WARNING = /^Nobody else can approve\b/;

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The card as it stands after this user's click: the API's card when it sent one. */
export function currentCard(action: ActionPart, decision: ActionDecision | undefined): ActionCardData {
  const card = honestCard(toActionCard(action));
  return decision?.ok && 'card' in decision ? honestCard(decision.card) : card;
}

export function statusOf(card: ActionCardData, decision: ActionDecision | undefined, now: number): ActionStatus {
  if (decision?.ok) return 'card' in decision ? honestCard(decision.card).status : decision.status;
  if (decision && !decision.ok && (decision.settled === 'EXPIRED' || decision.settled === 'STALE' || decision.settled === 'UNKNOWN')) return decision.settled;
  if (card.status === 'PENDING' && Date.parse(card.expiresAt) <= now) return 'EXPIRED';
  return card.status;
}

/** Suggested checkers first, then by name: the default choice is the one the API suggests. */
export function orderedCheckers(card: ActionCardData) {
  return [...(card.approval?.checkers ?? [])].sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
}

export function ActionCard({ action, decision, onDecided, userName }: { action: ActionPart; decision: ActionDecision | undefined; onDecided: (d: ActionDecision) => void; userName: string }) {
  const id = useId();
  const card = currentCard(action, decision);
  const [now, setNow] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<'confirm' | 'reject' | null>(null);
  const checkers = orderedCheckers(card);
  // A direct card can come back governed (the route asked for approval): default to the suggested checker then too.
  const [picked, setCheckerId] = useState('');
  const checkerId = checkers.some((c) => c.id === picked) ? picked : (checkers[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<{ field: 'checkerId' | 'reason'; message: string } | null>(null);

  const status = statusOf(card, decision, now);
  const error = decision && !decision.ok ? decision.message : null;
  const fieldError = localError ?? (decision && !decision.ok && decision.field ? { field: decision.field, message: decision.message } : null);
  // Decided elsewhere (another tab, or before a reload): show the API's word for it, no buttons.
  const decidedElsewhere = decision !== undefined && !decision.ok && decision.settled === 'DECIDED';
  const done = decidedElsewhere || status !== 'PENDING';
  const settledRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(!done);
  const kind = KIND[card.kind];
  const governed = card.kind === 'governed';
  const nobody = governed && (card.approval?.noEligibleChecker === true || checkers.length === 0);
  // The bold "nobody can approve" note already says this; the runtime also lists it as a warning.
  const showNobodyNote = !decidedElsewhere && status === 'PENDING' && nobody;
  const warnings = showNobodyNote ? card.warnings.filter((w) => !NOBODY_WARNING.test(w)) : card.warnings;

  useEffect(() => {
    // The buttons disappear once decided: keep keyboard focus on the outcome.
    if (wasOpen.current && done) settledRef.current?.focus();
    wasOpen.current = !done;
  }, [done]);

  useEffect(() => {
    // A pending card closes itself when its window ends.
    if (done) return;
    const left = Date.parse(card.expiresAt) - Date.now();
    if (!Number.isFinite(left)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(left + 250, 2_147_000_000)));
    return () => clearTimeout(timer);
  }, [card.expiresAt, done]);

  // Outcome unknown: re-read the card until OCSO knows how it ended, then show that.
  useReconcileUnknown(card.id, status === 'UNKNOWN' && !decision?.ok, onDecided);

  function confirm(event?: FormEvent) {
    event?.preventDefault();
    if (governed) {
      if (!checkerId) return setLocalError({ field: 'checkerId', message: 'Choose who approves this.' });
      if (reason.trim().length < 3) return setLocalError({ field: 'reason', message: 'Give a reason of at least 3 characters.' });
    }
    setLocalError(null);
    setChoice('confirm');
    startTransition(async () => {
      onDecided(await confirmAskOcsoAction(card.id, governed ? { checkerId, reason: reason.trim() } : {}));
    });
  }

  function cancel() {
    setLocalError(null);
    setChoice('reject');
    startTransition(async () => {
      onDecided(await rejectAskOcsoAction(card.id));
    });
  }

  const objectHref = card.object?.href ? safeHref(card.object.href) : null;
  const continueHref = safeHref(card.approval?.uiHref ?? '') ?? objectHref;
  const resultHref = card.result?.href ? safeHref(card.result.href) : null;
  const titleId = `${id}-title`;

  return (
    <div className="confirm ia-card" role="group" aria-labelledby={titleId} data-kind={card.kind} data-status={decidedElsewhere ? 'DECIDED' : status}>
      <span className="rowsplit ia-card-head">
        <span className="cl">{kind.heading}</span>
        <span className="sp" />
        <span className={`schip ${kind.tone}`}>{kind.badge}</span>
      </span>
      <span className="cx">
        <b id={titleId}>{card.title}</b>
        {card.summary ? <> {card.summary}</> : null}
      </span>
      {card.object ? (
        <span className="ia-object">
          <span className="mono-sm">{card.object.kind.replaceAll('_', ' ')}</span>{' '}
          {objectHref ? (
            <Link href={objectHref}>{card.object.name}</Link>
          ) : (
            <span>{card.object.name}</span>
          )}
        </span>
      ) : null}
      {card.changes.length ? (
        <table className="ia-diff">
          <caption className="sr-only">What will change</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Now</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {card.changes.map((c, i) => (
              <tr key={`${c.label}-${i}`}>
                <th scope="row">{c.label}</th>
                <td className={c.before === null || c.before === '' ? 'ia-none' : undefined}>{c.before || '—'}</td>
                <td>
                  <b>{c.after}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {warnings.length ? (
        <ul className="ia-warnings" aria-label="Before you confirm">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      {decidedElsewhere ? (
        <div className="ia-outcome" ref={settledRef} tabIndex={-1} role="status">
          <span className="schip muted">decided</span> {error}
        </div>
      ) : showNobodyNote ? (
        <>
          <div className="ia-nobody" role="note">
            <b>Nobody else can approve this; open it in OCSO to continue.</b>{' '}
            {continueHref ? (
              <Link href={continueHref} className="ia-continue">
                Open in OCSO →
              </Link>
            ) : null}
          </div>
          <span className="rowsplit">
            <button type="button" className="btn tiny ghost" onClick={cancel} disabled={pending}>
              {pending && choice === 'reject' ? 'Cancelling…' : 'Cancel'}
            </button>
          </span>
        </>
      ) : status === 'PENDING' ? (
        <form className="ia-card-form" onSubmit={confirm} noValidate>
          {governed ? (
            <span className="ia-approval">
              <span className="ia-field">
                <label htmlFor={`${id}-checker`}>Who approves</label>
                <select
                  id={`${id}-checker`}
                  className="ia-select"
                  value={checkerId}
                  onChange={(e) => setCheckerId(e.target.value)}
                  disabled={pending}
                  required
                  aria-invalid={fieldError?.field === 'checkerId' || undefined}
                  aria-describedby={fieldError?.field === 'checkerId' ? `${id}-err` : undefined}
                >
                  {checkers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {[c.name, roleLabel(c.role), c.suggested ? 'suggested' : ''].filter(Boolean).join(' · ')}
                    </option>
                  ))}
                </select>
              </span>
              <span className="ia-field">
                <label htmlFor={`${id}-reason`}>Reason</label>
                <textarea
                  id={`${id}-reason`}
                  className="ia-reason"
                  rows={2}
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={pending}
                  required
                  placeholder="Why this change, for the checker and the audit log"
                  aria-invalid={fieldError?.field === 'reason' || undefined}
                  aria-describedby={fieldError?.field === 'reason' ? `${id}-err` : undefined}
                />
              </span>
            </span>
          ) : null}
          {fieldError ? (
            <span className="ia-error" role="alert" id={`${id}-err`}>
              {fieldError.message}
            </span>
          ) : error ? (
            <span className="ia-error" role="alert">
              {error}
            </span>
          ) : null}
          <span className="rowsplit">
            <button type="submit" className="btn tiny accent" disabled={pending}>
              {pending && choice === 'confirm' ? kind.working : kind.confirm}
            </button>
            <button type="button" className="btn tiny ghost" onClick={cancel} disabled={pending}>
              {pending && choice === 'reject' ? 'Cancelling…' : 'Cancel'}
            </button>
            <span className="sp" />
            <span className="mono-sm">
              attributed to {userName} · audit · until {time(card.expiresAt)}
            </span>
          </span>
        </form>
      ) : (
        <div className="ia-outcome" ref={settledRef} tabIndex={-1} role="status">
          <span className={`schip ${OUTCOME[status].tone}`}>{OUTCOME[status].chip}</span>{' '}
          <span>{status === 'UNKNOWN' && !decision?.ok ? (error ?? OUTCOME.UNKNOWN.text) : (card.result?.message ?? (error && status !== 'EXPIRED' && status !== 'STALE' ? error : OUTCOME[status].text))}</span>
          {status === 'UNKNOWN' ? (
            (resultHref ?? objectHref) ? (
              <Link href={(resultHref ?? objectHref)!} className="ia-continue">
                Check it in OCSO →
              </Link>
            ) : null
          ) : resultHref ? (
            <Link href={resultHref} className="ia-continue">
              {status === 'SUBMITTED' ? 'Open the proposal →' : 'Open →'}
            </Link>
          ) : null}
        </div>
      )}
      {decision?.ok && !('card' in decision) && decision.status === 'EXECUTED' ? (
        <>
          {decision.table ? <MiniTable table={decision.table} /> : null}
          <LinkCards links={decision.links} />
        </>
      ) : null}
    </div>
  );
}
