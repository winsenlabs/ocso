import type { CSSProperties, ReactNode } from 'react';

export type AlertTone = 'info' | 'warn' | 'error';

export interface AlertBannerProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Right-aligned action (button or link). */
  action?: ReactNode;
  style?: CSSProperties;
}

/** Inline alert (.alert / .alert.warn / .alert.error). Errors are announced. */
export function AlertBanner({ tone = 'info', title, children, action, style }: AlertBannerProps) {
  return (
    <div
      className={tone === 'info' ? 'alert' : `alert ${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      style={style}
    >
      <span>
        {title ? <b>{title}</b> : null}
        {children ? (
          <span className="a-body" style={title ? { display: 'block' } : undefined}>
            {children}
          </span>
        ) : null}
      </span>
      {action ? <span style={{ marginLeft: 'auto', alignSelf: 'center' }}>{action}</span> : null}
    </div>
  );
}
