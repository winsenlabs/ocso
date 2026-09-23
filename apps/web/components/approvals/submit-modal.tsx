'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { checkerChoiceAction } from '@/lib/actions/approvals';
import type { CheckerChoice } from './lib/schemas';

/** What the maker picks: a named checker and a reason, or — when nobody else could check it — a bootstrap approval. */
export type ApprovalChoice = { checkerId: string; reason: string } | { bootstrap: true; reason: string };

export interface ApprovalTarget {
  objectKind: string;
  objectId: string;
  /** "Take Maya live" — the proposal's working title. */
  title: string;
  /** Plain-words list of what changes, when known ("purpose, business hours"). */
  changes?: string | undefined;
}

/**
 * Submit for approval (PM/research/11 §4.1), reusable by every object screen:
 * loads who may check this object, asks for a reason, and calls `submit` with
 * the choice — the screen re-sends its own write with `approval`, which the
 * API turns into a proposal (202).
 */
export function SubmitForApprovalModal({
  target,
  submit,
  onClose,
}: {
  target: ApprovalTarget;
  submit: (choice: ApprovalChoice) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<CheckerChoice | null>(null);
  const [checkerId, setCheckerId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void checkerChoiceAction(target.objectKind, target.objectId).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setChoice(r.data);
      setCheckerId(r.data.checkers[0]?.id ?? (r.data.bootstrapAllowed ? 'self' : ''));
    });
    return () => {
      live = false;
    };
  }, [target.objectKind, target.objectId]);

  async function send() {
    setPending(true);
    setError(null);
    const pick: ApprovalChoice = checkerId === 'self' ? { bootstrap: true, reason } : { checkerId, reason };
    const r = await submit(pick);
    setPending(false);
    if (!r.ok) setError(r.message);
    else onClose();
  }

  const nobody = choice !== null && choice.checkers.length === 0 && !choice.bootstrapAllowed;
  return createPortal(
    <Modal
      title="Submit for approval"
      sub="maker–checker · recorded in the audit log"
      onClose={() => !pending && onClose()}
      maxWidth={520}
      footer={
        <>
          <span className="mono-sm">nothing changes until the checker approves</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="btn accent" disabled={pending || !checkerId || reason.trim().length < 3} onClick={() => void send()}>
            {pending ? 'Submitting…' : checkerId === 'self' ? 'Approve as the only checker' : 'Submit for approval'}
          </button>
        </>
      }
    >
      <div className="ap-form">
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error}
          </AlertBanner>
        ) : null}
        <div className="confirm">
          <span className="cl">{target.title}</span>
          <span className="cx">{target.changes ? `Changes: ${target.changes}.` : 'This change needs a second person’s approval before it takes effect.'}</span>
        </div>
        <label htmlFor="approval-checker">checker</label>
        {choice === null && !error ? <span className="mono-sm">Loading who can approve this…</span> : null}
        {nobody ? (
          <AlertBanner tone="warn" style={{ margin: 0 }}>
            Nobody can approve this yet: it needs someone else in the object’s team with approval rights for it. Ask a Tech admin.
          </AlertBanner>
        ) : null}
        {choice && !nobody ? (
          <select id="approval-checker" value={checkerId} onChange={(e) => setCheckerId(e.target.value)}>
            {choice.checkers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {choice.bootstrapAllowed ? <option value="self">Approve it myself — nobody else can check it (bootstrap, reported)</option> : null}
          </select>
        ) : null}
        <label htmlFor="approval-reason">reason</label>
        <textarea id="approval-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Why this change, for the checker and the audit log" />
      </div>
    </Modal>,
    document.body,
  );
}
