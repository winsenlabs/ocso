import type { ReactNode } from 'react';

/** A centred section heading, as on the Rho site, with an optional mono eyebrow. */
export function Heading({ eyebrow, title, lede }: { eyebrow?: string; title: ReactNode; lede?: ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl text-balance text-center">
      {eyebrow && <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-accent">{eyebrow}</p>}
      <h2 className="text-4xl font-medium tracking-[-0.03em] text-fg md:text-5xl">{title}</h2>
      {lede && <p className="mx-auto mt-4 max-w-2xl text-lg text-fg/60">{lede}</p>}
    </div>
  );
}
