'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import type { ActionResult } from '@/lib/actions/models';

export interface ConfirmActionProps {
  /** Trigger button text. */
  label: string;
  title: string;
  /** What will happen, in plain words (shown in the design's `.confirm` box). */
  children: ReactNode;
  confirmLabel: string;
  /** When set, the user must type this (e.g. the connection name) to enable the confirm button. */
  typeToConfirm?: string;
  buttonClass?: string;
  run: () => Promise<ActionResult<unknown>>;
  onDone?: () => void;
  disabled?: boolean;
}

/**
 * Audit-relevant confirmation for destructive actions (delete, disable).
 * The change is attributed to the signed-in user in the audit log. The
 * dialog is portalled to <body> so Escape closes only it when it is opened
 * from another dialog or drawer.
 */
export function ConfirmAction({ label, title, children, confirmLabel, typeToConfirm, buttonClass = 'btn tiny danger', run, onDone, disabled }: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ready = !typeToConfirm || typed.trim() === typeToConfirm;

  function close() {
    if (pending) return;
    setOpen(false);
    setTyped('');
    setError(null);
  }

  function confirm() {
    start(async () => {
      const result = await run();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      setTyped('');
      onDone?.();
    });
  }

  return (
    <>
      <button type="button" className={buttonClass} onClick={() => setOpen(true)} disabled={disabled}>
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
                  <button type="button" className="btn" onClick={close} disabled={pending}>
                    Cancel
                  </button>
                  <button type="button" className="btn danger" onClick={confirm} disabled={!ready || pending}>
                    {pending ? 'Working…' : confirmLabel}
                  </button>
                </>
              }
            >
              {error ? (
                <AlertBanner tone="error" style={{ margin: 0 }}>
                  {error}
                </AlertBanner>
              ) : null}
              <div className="confirm">
                <span className="cl">{title}</span>
                <span className="cx">{children}</span>
              </div>
              {typeToConfirm ? (
                <div className="fld">
                  <label htmlFor="confirm-type">
                    Type <span className="mono">{typeToConfirm}</span> to confirm
                  </label>
                  <input id="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />
                </div>
              ) : null}
            </Modal>,
            document.body,
          )
        : null}
    </>
  );
}
