'use client';

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import type { ActionResult } from '@/lib/actions/agents';
import { useAgentAction } from './use-action';

export interface ConfirmButtonProps {
  label: ReactNode;
  title: string;
  /** What will happen, in plain words. */
  children: ReactNode;
  confirmLabel: string;
  run: () => Promise<ActionResult<unknown>>;
  buttonClass?: string;
  tone?: 'accent' | 'danger';
  disabled?: boolean;
  /** Accessible name when the label is terse (e.g. "Activate v3"). */
  ariaLabel?: string;
}

/** A button that asks before an audited change (activate, roll back, delete, pause). */
export function ConfirmButton({ label, title, children, confirmLabel, run, buttonClass = 'btn tiny', tone = 'accent', disabled, ariaLabel }: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const action = useAgentAction();
  const close = () => {
    if (action.pending) return;
    setOpen(false);
    action.setError(null);
  };
  return (
    <>
      <button type="button" className={buttonClass} onClick={() => setOpen(true)} disabled={disabled} aria-label={ariaLabel}>
        {label}
      </button>
      {open
        ? createPortal(
            <Modal
              title={title}
              sub="recorded in the audit log"
              onClose={close}
              maxWidth={480}
              footer={
                <>
                  <span className="sp" />
                  <button type="button" className="btn" onClick={close} disabled={action.pending}>
                    Cancel
                  </button>
                  <button type="button" className={`btn ${tone}`} disabled={action.pending} onClick={() => action.run(run, () => setOpen(false))}>
                    {action.pending ? 'Working…' : confirmLabel}
                  </button>
                </>
              }
            >
              {action.error ? (
                <AlertBanner tone="error" style={{ margin: 0 }}>
                  {action.error}
                </AlertBanner>
              ) : null}
              <div className="confirm">
                <span className="cl">{title}</span>
                <span className="cx">{children}</span>
              </div>
            </Modal>,
            document.body,
          )
        : null}
    </>
  );
}
