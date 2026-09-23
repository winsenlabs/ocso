'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { decideApprovalAction } from '@/lib/actions/approvals';

/**
 * Approve, or reject with a reason. The content and dependency hashes the
 * checker was shown travel with the decision: if the proposal changed in the
 * meantime the API answers 409 and nothing is decided.
 */
export function DecisionForm({ id, contentHash, dependencyHash, blocking }: { id: string; contentHash: string; dependencyHash: string; blocking: boolean }) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();

  function decide(decision: 'APPROVE' | 'REJECT') {
    setMessage(null);
    start(async () => {
      const r = await decideApprovalAction({ id, decision, reason, contentHash, dependencyHash });
      if (!r.ok) {
        const stale = r.code === 'content_changed' || r.code === 'dependency_changed';
        setMessage({ tone: 'error', text: stale ? `${r.message} The page has been refreshed with the current version.` : r.message });
        return;
      }
      setMessage({ tone: 'info', text: r.data.status === 'BLOCKED' ? 'Blocked: the change no longer passes validation; nothing changed.' : decision === 'APPROVE' ? 'Approved · recorded in the audit log' : 'Rejected · the maker has been told' });
    });
  }

  return (
    <div className="ap-form" aria-label="Decision">
      {message ? (
        <AlertBanner tone={message.tone} style={{ margin: 0 }}>
          {message.text}
        </AlertBanner>
      ) : null}
      <label htmlFor={`reason-${id}`}>reason (required to reject)</label>
      <textarea id={`reason-${id}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="What you checked, or why not" />
      <div className="rowsplit">
        <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={() => decide('REJECT')}>
          Reject
        </button>
        <span className="sp" />
        {pending ? <span className="mono-sm">working…</span> : null}
        <button type="button" className="btn accent" disabled={pending} onClick={() => decide('APPROVE')} title={blocking ? 'Review the warnings above before approving' : undefined}>
          Approve
        </button>
      </div>
    </div>
  );
}
