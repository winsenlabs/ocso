'use client';

import { useState, useTransition } from 'react';
import { regenerateReportAction, type RegenerateState } from '@/lib/actions/exceptions';

/**
 * Replaces an unsigned report with a freshly computed one over the same period
 * (exceptions.sign) — for a draft whose checks failed or that was wrong. The
 * draft is kept, marked superseded; the reason is audited.
 */
export function RegenerateReportForm({ reportId }: { reportId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<RegenerateState>({ status: 'idle' });
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <button type="button" className="btn ghost" onClick={() => setOpen(true)}>
        Regenerate…
      </button>
    );
  }
  return (
    <form
      className="ap-form exc-regenerate"
      aria-label="Regenerate this report"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setState(await regenerateReportAction(reportId, reason.trim())));
      }}
    >
      <label htmlFor="exc-regen-reason">Why regenerate it</label>
      <input id="exc-regen-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. the audit store check timed out" />
      <p className="mono-sm" style={{ margin: 0 }}>
        The checks run again over the same period. This draft is kept, marked superseded, and points to the new report.
      </p>
      <div className="rowsplit" style={{ gap: 8, alignItems: 'center' }}>
        <button type="submit" className="btn" disabled={pending || reason.trim().length < 3}>
          {pending ? 'Regenerating…' : 'Regenerate report'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        {state.status === 'error' ? (
          <span className="mono-sm" role="alert">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
