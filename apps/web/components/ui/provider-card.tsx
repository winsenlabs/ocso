import type { ReactNode } from 'react';
import { StatusChip, type StatusTone } from './status-chip';

export interface ProviderCardProps {
  /** Short mono logo text, e.g. "AWS" (never a vendor logo). Pass a node for channel marks. */
  logo: ReactNode;
  name: string;
  status: { tone: StatusTone; label: string };
  /** Card border tone for elevated / failing providers. */
  tone?: 'warn' | 'danger';
  metrics?: Array<{ label: string; value: ReactNode }>;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Provider / connection / channel card (.pvd). */
export function ProviderCard({ logo, name, status, tone, metrics, children, footer }: ProviderCardProps) {
  return (
    <div className={tone ? `pvd ${tone}` : 'pvd'}>
      <div className="h">
        {typeof logo === 'string' ? (
          <span className="logo" aria-hidden="true">
            {logo}
          </span>
        ) : (
          logo
        )}
        <span className="nm">{name}</span>
        <span style={{ marginLeft: 'auto' }}>
          <StatusChip tone={status.tone}>{status.label}</StatusChip>
        </span>
      </div>
      {children}
      {metrics?.length ? (
        <div className="mets">
          {metrics.map((m) => (
            <div className="met" key={m.label}>
              <div className="v">{m.value}</div>
              <div className="k">{m.label}</div>
            </div>
          ))}
        </div>
      ) : null}
      {footer}
    </div>
  );
}
