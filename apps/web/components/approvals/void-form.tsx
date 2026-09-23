'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { voidApprovalAction } from '@/lib/actions/approvals';

/** Void an open proposal nobody can decide any more (approvals.reassign_any). Audited; nothing is applied. */
export function VoidForm({ id }: { id: string }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="ap-form" aria-label="Void">
      {error ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {error}
        </AlertBanner>
      ) : null}
      <label htmlFor={`void-reason-${id}`}>reason</label>
      <textarea id={`void-reason-${id}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Why this proposal is closed without a decision" />
      <div className="rowsplit">
        <span className="sp" />
        <button
          type="button"
          className="btn ghost"
          disabled={pending || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const r = await voidApprovalAction(id, reason);
              if (!r.ok) setError(r.message);
            })
          }
        >
          Void proposal
        </button>
      </div>
    </div>
  );
}
