'use client';

import { useState, useTransition } from 'react';
import { acknowledgeChainBreakAction, type AcknowledgeState } from '@/lib/actions/audit-store';

/**
 * Closes a CHAIN_BROKEN incident once someone has investigated it (audit.verify).
 * The note is kept on the incident and in the audit log; nothing in the store changes.
 */
export function ChainBreakAcknowledge({ incidentId }: { incidentId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [state, setState] = useState<AcknowledgeState>({ status: 'idle' });
  const [pending, start] = useTransition();
  if (state.status === 'done') return <span className="mono-sm" role="status">Acknowledged.</span>;
  if (!open) {
    return (
      <button type="button" className="btn tiny ghost" onClick={() => setOpen(true)}>
        Acknowledge break
      </button>
    );
  }
  return (
    <form
      style={{ display: 'grid', gap: 6, marginTop: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setState(await acknowledgeChainBreakAction(incidentId, note)));
      }}
    >
      <label className="mono-sm" htmlFor={`ack-${incidentId}`}>
        What was investigated, and what was found
      </label>
      <textarea id={`ack-${incidentId}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} minLength={10} maxLength={2000} required />
      <div className="rowsplit" style={{ gap: 8, alignItems: 'center' }}>
        <button type="submit" className="btn tiny" disabled={pending}>
          {pending ? 'Saving…' : 'Acknowledge'}
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
