'use client';

import { useState, useTransition } from 'react';
import { signExceptionReportAction, type SignState } from '@/lib/actions/exceptions';
import { ATTESTATION_TEXT } from './exceptions-meta';

/**
 * Signs the report shown (exceptions.sign): the content hash on screen is what
 * gets signed, with the audit signing key. Anything the sign-off attests (the
 * signer is named in it, checks failed, data incomplete) must be acknowledged
 * first; it is signed with the report. The report can never change afterwards.
 */
export function SignReportForm({ reportId, contentHash, attestation }: { reportId: string; contentHash: string; attestation: string[] }) {
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<SignState>({ status: 'idle' });
  const [pending, start] = useTransition();
  if (state.status === 'done') return <p role="status">Signed.</p>;
  const ready = attestation.every((f) => acknowledged.has(f));
  return (
    <form
      className="ap-form"
      aria-label="Sign this report"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setState(await signExceptionReportAction(reportId, contentHash, note, [...acknowledged])));
      }}
    >
      <label htmlFor="exc-note">Note (optional)</label>
      <textarea id="exc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What was reviewed, and with whom" />
      {attestation.length ? (
        <fieldset className="exc-attest">
          <legend>This sign-off attests</legend>
          {attestation.map((flag) => (
            <label key={flag} className="exc-check">
              <input
                type="checkbox"
                checked={acknowledged.has(flag)}
                onChange={(e) => setAcknowledged((cur) => (e.target.checked ? new Set([...cur, flag]) : new Set([...cur].filter((x) => x !== flag))))}
              />
              <span>{ATTESTATION_TEXT[flag]?.long ?? flag}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="mono-sm" style={{ margin: 0 }}>
        You sign content hash {contentHash.slice(0, 16)}…{note.trim() ? ', your note' : ''}
        {attestation.length ? ' and what you acknowledge above' : ''} with the deployment’s audit signing key. A signed report cannot be changed.
      </p>
      <div className="rowsplit" style={{ gap: 8, alignItems: 'center' }}>
        <button type="submit" className="btn" disabled={pending || !ready}>
          {pending ? 'Signing…' : 'Sign report'}
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
