'use client';

import { useId, useRef, type ReactNode } from 'react';
import { useDialogFocus } from './use-dialog-focus';

export interface DrawerProps {
  id?: string;
  title: ReactNode;
  /** Mono line under the title (scope). */
  sub?: ReactNode;
  /** Leading visual in the header (portrait). */
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Sticky footer (.dfoot), e.g. the composer. */
  footer?: ReactNode;
}

/**
 * Right overlay drawer (.rdrawer). Non-modal: the page stays usable behind it.
 * Focus moves in on open, Escape closes, focus returns to the opener.
 */
export function Drawer({ id, title, sub, icon, onClose, children, footer }: DrawerProps) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose, false);

  return (
    <aside ref={ref} id={id} className="rdrawer" role="dialog" aria-labelledby={titleId} tabIndex={-1}>
      <div className="dh">
        {icon}
        <span className="grow">
          <b id={titleId} style={{ fontSize: 13.5 }}>
            {title}
          </b>
          {sub ? (
            <span className="mono-sm" style={{ display: 'block' }}>
              {sub}
            </span>
          ) : null}
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="dbody">{children}</div>
      {footer ? <div className="dfoot">{footer}</div> : null}
    </aside>
  );
}
