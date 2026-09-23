'use client';

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import type { ApprovalChoice, ApprovalTarget } from './submit-modal';
import { useApprovalRequest } from './use-approval-request';

type Result = { ok: true; data: unknown } | { ok: false; message: string; code?: string | undefined };

export interface ApprovableButtonProps {
  label: ReactNode;
  /** Confirm dialog title, e.g. "Activate v3". */
  title: string;
  confirmLabel: string;
  /** What will happen, in plain words. */
  children: ReactNode;
  target: ApprovalTarget;
  /** The write; called again with `approval` when the API answers approval_required. */
  write: (approval?: ApprovalChoice) => Promise<Result>;
  /** The write is always a proposal (go live, resume, delete): skip the confirm and ask for a checker. */
  always?: boolean;
  tone?: 'accent' | 'danger';
  buttonClass?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * A confirm button for an approvable change (PM/research/11 §4.1): applies
 * directly while the object is a draft; once the API says approval_required,
 * the same click continues into the submit-for-approval modal.
 */
export function ApprovableButton({ label, title, confirmLabel, children, target, write, always, tone = 'accent', buttonClass = 'btn tiny', ariaLabel, disabled }: ApprovableButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const approval = useApprovalRequest();
  const start = () => (always ? approval.run(target, write, { always: true }) : setConfirming(true));
  return (
    <>
      <button type="button" className={buttonClass} onClick={start} disabled={disabled || approval.pending} aria-label={ariaLabel}>
        {label}
      </button>
      {approval.error || approval.notice ? (
        <AlertBanner tone={approval.error ? 'error' : 'info'} style={{ margin: '6px 0 0' }}>
          {approval.error ?? approval.notice}
        </AlertBanner>
      ) : null}
      {confirming
        ? createPortal(
            <Modal
              title={title}
              sub="recorded in the audit log"
              onClose={() => setConfirming(false)}
              maxWidth={480}
              footer={
                <>
                  <span className="sp" />
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`btn ${tone}`}
                    onClick={() => {
                      setConfirming(false);
                      approval.run(target, write);
                    }}
                  >
                    {confirmLabel}
                  </button>
                </>
              }
            >
              <div className="confirm">
                <span className="cl">{title}</span>
                <span className="cx">{children}</span>
              </div>
            </Modal>,
            document.body,
          )
        : null}
      {approval.modal}
    </>
  );
}
