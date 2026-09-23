'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { reassignApprovalAction } from '@/lib/actions/approvals';

/** Name a new checker (approvals.reassign_any, or the kind's check permission). Never automatic. */
export function ReassignForm({ id, candidates }: { id: string; candidates: Array<{ id: string; name: string; role: string | null }> }) {
  const [checkerId, setCheckerId] = useState(candidates[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (!candidates.length) return <span className="mono-sm">Nobody else is eligible to check this proposal.</span>;
  return (
    <div className="ap-form" aria-label="Reassign">
      {message ? (
        <AlertBanner tone={message.tone} style={{ margin: 0 }}>
          {message.text}
        </AlertBanner>
      ) : null}
      <label htmlFor={`checker-${id}`}>new checker</label>
      <select id={`checker-${id}`} value={checkerId} onChange={(e) => setCheckerId(e.target.value)}>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <label htmlFor={`reassign-reason-${id}`}>reason</label>
      <textarea id={`reassign-reason-${id}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Why the checker changes" />
      <div className="rowsplit">
        <span className="sp" />
        <button
          type="button"
          className="btn"
          disabled={pending || !checkerId || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const r = await reassignApprovalAction(id, checkerId, reason);
              setMessage(r.ok ? { tone: 'info', text: 'Reassigned · the new checker has been told' } : { tone: 'error', text: r.message });
            })
          }
        >
          Reassign
        </button>
      </div>
    </div>
  );
}
