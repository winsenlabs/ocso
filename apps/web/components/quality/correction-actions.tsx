'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { rejectCorrectionAction, stageCorrectionAction, type QualityResult } from '@/lib/actions/quality';

/**
 * Stage into the agent's prompt draft (APPEND adds a line, REPLACE swaps the
 * component) or reject. Nothing touches the live prompt: a CS Lead creates a
 * version from the draft on the agent's Prompt tab.
 */
export function CorrectionActions({ id, proposedText, desired, canStage, status }: { id: string; proposedText: string | null; desired: string; canStage: boolean; status: 'OPEN' | 'STAGED' }) {
  const [text, setText] = useState(proposedText ?? desired);
  const [mode, setMode] = useState<'APPEND' | 'REPLACE'>('APPEND');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<QualityResult | null>(null);
  const [pending, start] = useTransition();

  const run = (call: () => Promise<QualityResult>) => start(async () => setResult(await call()));

  return (
    <div className="ops-actions">
      {result ? (
        <AlertBanner tone={result.ok ? 'info' : 'error'} style={{ margin: 0 }}>
          {result.message}
        </AlertBanner>
      ) : null}
      {canStage ? (
        <div className="ops-stage">
          <div className="fld">
            <label htmlFor={`stage-${id}`}>{status === 'STAGED' ? 'Text in the draft (restage to change it)' : 'Text to stage into the prompt draft'}</label>
            <textarea id={`stage-${id}`} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="rowsplit" role="radiogroup" aria-label="How to stage">
            <label className="toggle-row">
              <input type="radio" name={`mode-${id}`} checked={mode === 'APPEND'} onChange={() => setMode('APPEND')} />
              Append as a new line
            </label>
            <label className="toggle-row">
              <input type="radio" name={`mode-${id}`} checked={mode === 'REPLACE'} onChange={() => setMode('REPLACE')} />
              Replace the whole component
            </label>
            <span className="sp" />
            <button type="button" className="btn tiny accent" disabled={pending || !text.trim()} onClick={() => run(() => stageCorrectionAction(id, { proposedText: text, mode }))}>
              {pending ? 'Working…' : status === 'STAGED' ? 'Restage' : 'Stage into draft'}
            </button>
          </div>
        </div>
      ) : (
        <p className="mono-sm" style={{ margin: 0 }}>
          Staging needs prompt editing rights (prompts.edit).
        </p>
      )}
      <div className="fld">
        <label htmlFor={`reject-${id}`}>Reject with a reason</label>
        <div className="rowsplit">
          <input id={`reject-${id}`} style={{ flex: 1, minWidth: 160 }} value={reason} maxLength={500} placeholder="optional · e.g. policy is correct as written" onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn tiny danger" disabled={pending} onClick={() => run(() => rejectCorrectionAction(id, reason))}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
