'use client';

import { createPortal } from 'react-dom';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';

export interface RemovalConfirmProps {
  title: string;
  /** The change in one sentence, e.g. "Remove Esha Exec from Cards?". */
  question: string;
  /** Consequences from describeRemoval(); `warn` when someone loses agent access. */
  effect: { warn: boolean; lines: string[] };
  confirmLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmation before a membership removal, spelling out who loses access to what. Portalled above the drawer. */
export function RemovalConfirm({ title, question, effect, confirmLabel, pending, error, onConfirm, onClose }: RemovalConfirmProps) {
  const close = () => {
    if (!pending) onClose();
  };
  const consequences = (
    <ul className="tm-effects" aria-label="What changes">
      {effect.lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
  return createPortal(
    <Modal
      title={title}
      sub="recorded in the audit log"
      onClose={close}
      maxWidth={500}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={effect.warn ? 'btn danger' : 'btn accent'} onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error}
          </AlertBanner>
        ) : null}
        <div className="confirm">
          <span className="cl">{title}</span>
          <span className="cx">{question}</span>
        </div>
        {effect.warn ? (
          <AlertBanner tone="warn" title="Access will be lost" style={{ margin: 0 }}>
            {consequences}
          </AlertBanner>
        ) : (
          consequences
        )}
      </div>
    </Modal>,
    document.body,
  );
}
