'use client';

import { useId, useRef, type ReactNode } from 'react';
import { useDialogFocus } from './use-dialog-focus';

export interface ModalProps {
  title: ReactNode;
  /** Mono caption next to the title. */
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Footer row (.mf): caption, spacer and buttons. */
  footer?: ReactNode;
  maxWidth?: number;
  /** Remove body padding (wizard layouts). */
  flush?: boolean;
}

/**
 * Modal dialog (.scrim/.modal/.mh/.mb/.mf). Focus is trapped, Escape and the
 * scrim close it, and focus returns to the opener.
 */
export function Modal({ title, sub, onClose, children, footer, maxWidth = 620, flush }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose, true);

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="modal" style={{ maxWidth }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="mh">
          <h2 id={titleId}>{title}</h2>
          {sub ? <span className="mono-sm">{sub}</span> : null}
          <span className="sp" style={{ flex: 1 }} />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        <div className="mb" style={flush ? { padding: 0 } : undefined}>
          {children}
        </div>
        {footer ? <div className="mf">{footer}</div> : null}
      </div>
    </div>
  );
}
