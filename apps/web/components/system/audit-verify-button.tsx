'use client';

import { useState, useTransition } from 'react';
import { verifyAuditChainAction, type VerifyState } from '@/lib/actions/audit-store';

/** Re-verifies the latest audit chain entries (hashes, links, checkpoint signatures) and says what it found. */
export function AuditVerifyButton() {
  const [state, setState] = useState<VerifyState>({ status: 'idle' });
  const [pending, start] = useTransition();
  const run = () => start(async () => setState(await verifyAuditChainAction()));
  return (
    <div className="rowsplit" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className="btn tiny ghost" onClick={run} disabled={pending}>
        {pending ? 'Verifying…' : 'Verify recent entries'}
      </button>
      <span className="mono-sm" role="status" aria-live="polite">
        {state.status === 'done'
          ? state.result.ok
            ? state.result.entries
              ? `Verified #${state.result.from}–${state.result.to}: ${state.result.entries} entries, ${state.result.checkpoints.valid} signed checkpoint${state.result.checkpoints.valid === 1 ? '' : 's'}, no problems`
              : 'Nothing sealed yet to verify'
            : `Verification failed: ${state.result.problems.length} problem${state.result.problems.length === 1 ? '' : 's'} in #${state.result.from}–${state.result.to} (first: ${state.result.problems[0]?.kind.toLowerCase().replace(/_/g, ' ')} at #${state.result.problems[0]?.position})`
          : state.status === 'error'
            ? state.message
            : null}
      </span>
    </div>
  );
}
