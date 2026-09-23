import type { ReactNode } from 'react';

export interface VersionRowProps {
  /** e.g. "v14". */
  version: string;
  title: ReactNode;
  sub?: ReactNode;
  who: string;
  when: string;
  live?: boolean;
}

/** Immutable, attributable version row (.vrow); the live version gets a green dot. */
export function VersionRow({ version, title, sub, who, when, live }: VersionRowProps) {
  return (
    <div className={live ? 'vrow live' : 'vrow'}>
      <span className="vdot" aria-label={live ? 'live version' : undefined} role={live ? 'img' : undefined} />
      <span className="vid">{version}</span>
      <span>
        {sub ? <b style={{ fontWeight: 500 }}>{title}</b> : title}
        {sub ? (
          <span className="mono-sm" style={{ display: 'block' }}>
            {sub}
          </span>
        ) : null}
      </span>
      <span className="vwho">{who}</span>
      <span className="mono-sm">{when}</span>
    </div>
  );
}
