import type { ReactNode } from 'react';

/** A page section with a numbered eyebrow, an h2 and an intro. */
export function Section({
  id,
  index,
  eyebrow,
  title,
  intro,
  tone = 'plain',
  children,
}: {
  id: string;
  index: string;
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  tone?: 'plain' | 'tint' | 'ink';
  children: ReactNode;
}) {
  return (
    <section id={id} className={`section section-${tone}`} aria-labelledby={`${id}-title`}>
      <div className="wrap">
        <header className="section-head">
          <p className="eyebrow">
            <span className="eyebrow-index">{index}</span>
            {eyebrow}
          </p>
          <h2 id={`${id}-title`}>{title}</h2>
          {intro ? <p className="section-intro">{intro}</p> : null}
        </header>
        {children}
      </div>
    </section>
  );
}
