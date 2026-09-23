'use client';

import { useState, useTransition } from 'react';
import { createAdhocReportAction, type AdhocState } from '@/lib/actions/exceptions';

/** A report over any past period (at most 31 days, within the last 90): frozen as a draft to sign. */
export function AdhocReportForm() {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [state, setState] = useState<AdhocState>({ status: 'idle' });
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button type="button" className="btn tiny ghost" onClick={() => setOpen(true)}>
          Report on another period
        </button>
      </div>
    );
  }
  return (
    <form
      className="ap-form exc-adhoc"
      onSubmit={(e) => {
        e.preventDefault();
        // Whole days in the browser's zone: from the start of the first to the end of the last.
        const startAt = new Date(`${from}T00:00:00`);
        const endAt = new Date(`${to}T00:00:00`);
        endAt.setDate(endAt.getDate() + 1);
        start(async () => setState(await createAdhocReportAction(startAt.toISOString(), endAt.toISOString())));
      }}
    >
      <label htmlFor="exc-from">From</label>
      <input id="exc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      <label htmlFor="exc-to">To (inclusive)</label>
      <input id="exc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
      <div className="rowsplit" style={{ gap: 8, alignItems: 'center' }}>
        <button type="submit" className="btn tiny" disabled={pending}>
          {pending ? 'Generating…' : 'Generate report'}
        </button>
        <button type="button" className="btn tiny ghost" onClick={() => setOpen(false)} disabled={pending}>
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
