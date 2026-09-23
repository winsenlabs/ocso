'use client';

import { useState } from 'react';
import { RiskBadge } from '../ui/risk-badge';
import { confirmToolCallAction, denyToolCallAction } from '../../lib/actions/conversations';
import { formatClock } from '../../lib/format';
import { factsOf } from './lib/timeline';
import { useActionRunner } from './lib/use-action';

export interface PendingConfirmation {
  id: string;
  toolName: string;
  connectionName: string | null;
  riskClass: string | null;
  /** Sanitized arguments exactly as the API shows them to the confirming human. */
  args: unknown;
  reason: string | null;
  expiresAt: string | null;
  requestedBy: 'AGENT' | 'HUMAN' | string;
}

export interface ConfirmCardProps {
  call: PendingConfirmation;
  agentName: string;
  now: number;
  /** tools.confirm_sensitive — without it the card is read-only. */
  canDecide: boolean;
}

/**
 * Sensitive-action confirmation (docs/08 §7, design/01 .confirm): the agent
 * proposed a call that policy holds for a human. Shows the risk, the
 * sanitized arguments and the expiry; "Confirm and run" executes exactly the
 * proposed arguments as this human, "Deny" records a reason.
 */
export function ConfirmCard({ call, agentName, now, canDecide }: ConfirmCardProps) {
  const { pending, error, run } = useActionRunner();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const left = call.expiresAt ? Math.round((Date.parse(call.expiresAt) - now) / 1000) : null;
  const expired = left !== null && left <= 0;
  const facts = factsOf(call.args, 8);
  const who = call.requestedBy === 'AGENT' ? `${agentName} proposed this action` : 'Proposed action';

  return (
    <div className="confirm inline" role="group" aria-label={`Confirm ${call.toolName}`}>
      <span className="cl" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        confirm sensitive action
        {call.riskClass === 'SENSITIVE' ? <RiskBadge risk="2-step" /> : call.riskClass === 'WRITE' ? <RiskBadge risk="write" /> : null}
      </span>
      <span className="cx">
        <b>{call.toolName}</b>
        {call.connectionName ? ` · ${call.connectionName}` : ''} · {who}
        {call.reason ? ` — ${call.reason.replace(/\.+$/, '')}.` : '.'} Runs as you and is written to the audit log.
      </span>
      {facts.length ? (
        <span className="kvs" aria-label="Arguments">
          {facts.map((f) => (
            <span key={f.k}>
              {f.k} <b>{f.v}</b>
            </span>
          ))}
        </span>
      ) : (
        <span className="mono-sm">no arguments</span>
      )}
      {denying ? (
        <form
          className="deny"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => denyToolCallAction(call.id, reason));
          }}
        >
          <label className="mono-sm" htmlFor={`deny-${call.id}`}>
            Reason for denying (shared with the audit log)
          </label>
          <input id={`deny-${call.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
          <span className="rowsplit">
            <button type="submit" className="btn tiny" disabled={pending || reason.trim().length < 3}>
              Deny action
            </button>
            <button type="button" className="btn tiny ghost" onClick={() => setDenying(false)} disabled={pending}>
              Back
            </button>
          </span>
        </form>
      ) : (
        <span className="rowsplit">
          {canDecide && !expired ? (
            <>
              <button type="button" className="btn tiny accent" disabled={pending} onClick={() => void run(() => confirmToolCallAction(call.id))}>
                {pending ? 'Running…' : 'Confirm and run'}
              </button>
              <button type="button" className="btn tiny ghost" disabled={pending} onClick={() => setDenying(true)}>
                Deny
              </button>
            </>
          ) : null}
          <span className="sp" />
          <span className="mono-sm">
            {expired ? 'confirmation window expired' : left !== null ? `expires in ${formatClock(left)}` : 'no expiry'}
            {!canDecide ? ' · your role cannot confirm sensitive actions' : ''}
          </span>
        </span>
      )}
      {error ? (
        <span role="alert" style={{ color: 'var(--danger)', fontSize: 12 }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
