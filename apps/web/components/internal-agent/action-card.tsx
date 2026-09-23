'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { confirmAskOcsoAction, rejectAskOcsoAction, type ActionDecision } from '../../lib/actions/internal-agent';
import { LinkCards, MiniTable } from './parts';
import type { ActionStatus, PendingAction } from './types';

/**
 * A write the agent proposed (docs/12 §4, design/05 `.confirm`). Nothing
 * changes until this user confirms; the API then re-checks their permission,
 * executes through the normal service and audits it under their name.
 */

const OUTCOME: Record<Exclude<ActionStatus, 'PENDING'>, { chip: string; tone: string; text: string }> = {
  EXECUTED: { chip: 'confirmed', tone: 'good', text: 'Applied. The change is recorded in the audit log under your name.' },
  REJECTED: { chip: 'rejected', tone: 'muted', text: 'Nothing was changed.' },
  EXPIRED: { chip: 'expired', tone: 'muted', text: 'Not confirmed in time, so nothing was changed. Ask again to get a fresh proposal.' },
  FAILED: { chip: 'failed', tone: 'danger', text: 'It could not be applied, so nothing was changed.' },
};

function statusOf(action: PendingAction, decision: ActionDecision | undefined): ActionStatus {
  if (decision?.ok) return decision.status;
  if (decision && !decision.ok && decision.settled === 'EXPIRED') return 'EXPIRED';
  return action.status ?? 'PENDING';
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ActionCard({ action, decision, onDecided, userName }: { action: PendingAction; decision: ActionDecision | undefined; onDecided: (d: ActionDecision) => void; userName: string }) {
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<'confirm' | 'reject' | null>(null);
  const status = statusOf(action, decision);
  const error = decision && !decision.ok ? decision.message : null;
  // Decided elsewhere (another tab, or before a reload): show the API's word for it, no buttons.
  const decidedElsewhere = decision !== undefined && !decision.ok && decision.settled === 'DECIDED';
  const done = decidedElsewhere || status !== 'PENDING';
  const settledRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(!done);

  useEffect(() => {
    // The buttons disappear once decided: keep keyboard focus on the outcome.
    if (wasOpen.current && done) settledRef.current?.focus();
    wasOpen.current = !done;
  }, [done]);

  function decide(kind: 'confirm' | 'reject') {
    setChoice(kind);
    startTransition(async () => {
      onDecided(await (kind === 'confirm' ? confirmAskOcsoAction(action.id) : rejectAskOcsoAction(action.id)));
    });
  }

  const sensitive = action.risk === 'HIGH_WRITE';
  return (
    <div className="confirm" role="group" aria-label={sensitive ? 'Confirm sensitive change' : 'Confirm change'}>
      <span className="cl">{sensitive ? 'confirm sensitive change' : 'confirm change'}</span>
      <span className="cx">
        <b>{action.description}</b>
      </span>
      {action.changes?.length ? (
        <ul className="ia-changes" aria-label="What will change">
          {action.changes.map((c) => (
            <li key={c.label}>
              <span>{c.label}</span>
              <span className="mono">
                {c.before ?? '—'} → <b>{c.after}</b>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {decidedElsewhere ? (
        <div className="ia-outcome" ref={settledRef} tabIndex={-1} role="status">
          <span className="schip muted">decided</span> {error}
        </div>
      ) : status === 'PENDING' ? (
        <>
          {error ? (
            <span className="ia-error" role="alert">
              {error}
            </span>
          ) : null}
          <span className="rowsplit">
            <button type="button" className="btn tiny accent" onClick={() => decide('confirm')} disabled={pending}>
              {pending && choice === 'confirm' ? 'Applying…' : 'Confirm change'}
            </button>
            <button type="button" className="btn tiny ghost" onClick={() => decide('reject')} disabled={pending}>
              {pending && choice === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            <span className="sp" />
            <span className="mono-sm">
              attributed to {userName} · audit · until {time(action.expiresAt)}
            </span>
          </span>
        </>
      ) : (
        <div className="ia-outcome" ref={settledRef} tabIndex={-1} role="status">
          <span className={`schip ${OUTCOME[status].tone}`}>{OUTCOME[status].chip}</span> {error && status !== 'EXPIRED' ? error : OUTCOME[status].text}
        </div>
      )}
      {decision?.ok && decision.status === 'EXECUTED' ? (
        <>
          {decision.table ? <MiniTable table={decision.table} /> : null}
          <LinkCards links={decision.links} />
        </>
      ) : null}
    </div>
  );
}
