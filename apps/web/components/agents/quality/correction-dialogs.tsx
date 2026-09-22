'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { createCorrectionAction, rejectCorrectionAction, stageCorrectionAction } from '@/lib/actions/agents';
import { COMPONENT_KEYS, type ComponentKey } from '../data/agent-schemas';
import type { Correction } from '../data/quality-schemas';
import { useAgentAction } from '../shared/use-action';

type Labels = Readonly<Record<string, string>>;

/** Stage (write into the prompt draft, never the live prompt) or reject one correction (docs/09 §7). */
export function CorrectionActions({ correction: c, labels }: { correction: Correction; labels: Labels }) {
  const [mode, setMode] = useState<'stage' | 'reject' | null>(null);
  if (c.status !== 'OPEN' && c.status !== 'STAGED') return null;
  return (
    <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
      <button type="button" className="btn tiny" onClick={() => setMode('stage')} aria-label={`${c.status === 'STAGED' ? 'Re-stage' : 'Stage'} ${c.title}`}>
        {c.status === 'STAGED' ? 'Re-stage' : 'Stage'}
      </button>
      <button type="button" className="btn tiny ghost" onClick={() => setMode('reject')} aria-label={`Reject ${c.title}`}>
        Reject
      </button>
      {mode === 'stage' ? <StageDialog correction={c} label={labels[c.componentKey] ?? c.componentKey} onClose={() => setMode(null)} /> : null}
      {mode === 'reject' ? <RejectDialog correction={c} onClose={() => setMode(null)} /> : null}
    </span>
  );
}

function StageDialog({ correction: c, label, onClose }: { correction: Correction; label: string; onClose: () => void }) {
  const action = useAgentAction();
  const [text, setText] = useState(c.proposedText ?? c.desired);
  const [how, setHow] = useState<'APPEND' | 'REPLACE'>('APPEND');
  return (
    <Modal
      title={`Stage into ${label}`}
      sub="writes the prompt draft · not live until a version is activated"
      onClose={() => !action.pending && onClose()}
      maxWidth={600}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={action.pending}>
            Cancel
          </button>
          <button type="button" className="btn accent" disabled={action.pending || !text.trim()} onClick={() => action.run(() => stageCorrectionAction(c.id, text, how), onClose)}>
            {action.pending ? 'Staging…' : 'Stage in draft'}
          </button>
        </>
      }
    >
      <div className="agent-form">
        {action.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error}</AlertBanner> : null}
        <p className="mono-sm" style={{ margin: 0 }}>
          observed: {c.observed} · desired: {c.desired}
        </p>
        <div className="fld">
          <label htmlFor="stage-text">Text for the {label} component</label>
          <textarea id="stage-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} maxLength={20_000} data-autofocus />
        </div>
        <div className="checks" role="radiogroup" aria-label="How to apply">
          <label>
            <input type="radio" name="how" checked={how === 'APPEND'} onChange={() => setHow('APPEND')} /> Add as a new line
          </label>
          <label>
            <input type="radio" name="how" checked={how === 'REPLACE'} onChange={() => setHow('REPLACE')} /> Replace the whole component
          </label>
        </div>
      </div>
    </Modal>
  );
}

function RejectDialog({ correction: c, onClose }: { correction: Correction; onClose: () => void }) {
  const action = useAgentAction();
  const [reason, setReason] = useState('');
  return (
    <Modal
      title="Reject correction"
      sub="recorded in the audit log"
      onClose={() => !action.pending && onClose()}
      maxWidth={500}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={action.pending}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={action.pending} onClick={() => action.run(() => rejectCorrectionAction(c.id, reason), onClose)}>
            {action.pending ? 'Rejecting…' : 'Reject'}
          </button>
        </>
      }
    >
      <div className="agent-form">
        {action.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error}</AlertBanner> : null}
        <p style={{ margin: 0, fontSize: 12.5 }}>{c.title}</p>
        {c.status === 'STAGED' ? <AlertBanner tone="warn" style={{ margin: 0 }}>Its text stays in the draft; remove it in the Prompt tab if it should not ship.</AlertBanner> : null}
        <div className="fld">
          <label htmlFor="reject-reason">Reason (optional)</label>
          <input id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-autofocus />
        </div>
      </div>
    </Modal>
  );
}

/** Record a correction without a source conversation (e.g. from a review or a policy change). */
export function NewCorrectionButton({ agentId, labels }: { agentId: string; labels: Labels }) {
  const [open, setOpen] = useState(false);
  const action = useAgentAction();
  const [form, setForm] = useState({ title: '', observed: '', desired: '', componentKey: 'behavior' as ComponentKey, proposedText: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = () =>
    action.run(
      () => createCorrectionAction({ agentId, ...form }),
      () => {
        setOpen(false);
        setForm({ title: '', observed: '', desired: '', componentKey: 'behavior', proposedText: '' });
      },
    );
  return (
    <>
      <button type="button" className="btn tiny" onClick={() => setOpen(true)}>
        Record correction
      </button>
      {open ? (
        <Modal
          title="Record a prompt correction"
          sub="goes to the review queue · the prompt is not changed yet"
          onClose={() => !action.pending && setOpen(false)}
          maxWidth={600}
          footer={
            <>
              <span className="sp" />
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={action.pending}>
                Cancel
              </button>
              <button type="button" className="btn accent" onClick={submit} disabled={action.pending}>
                {action.pending ? 'Saving…' : 'Record correction'}
              </button>
            </>
          }
        >
          <div className="agent-form">
            {action.error ? <AlertBanner tone="error" style={{ margin: 0 }}>{action.error}</AlertBanner> : null}
            <div className="fld-row">
              <div className="fld">
                <label htmlFor="nc-title">Title</label>
                <input id="nc-title" value={form.title} onChange={set('title')} maxLength={200} data-autofocus />
              </div>
              <div className="fld">
                <label htmlFor="nc-component">Component</label>
                <select id="nc-component" value={form.componentKey} onChange={set('componentKey')}>
                  {COMPONENT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {labels[k] ?? k}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="fld">
              <label htmlFor="nc-observed">Observed behavior</label>
              <textarea id="nc-observed" rows={2} value={form.observed} onChange={set('observed')} maxLength={2000} />
            </div>
            <div className="fld">
              <label htmlFor="nc-desired">Desired behavior</label>
              <textarea id="nc-desired" rows={2} value={form.desired} onChange={set('desired')} maxLength={2000} />
            </div>
            <div className="fld">
              <label htmlFor="nc-proposed">Proposed prompt text (optional)</label>
              <textarea id="nc-proposed" rows={3} value={form.proposedText} onChange={set('proposedText')} maxLength={20_000} />
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
