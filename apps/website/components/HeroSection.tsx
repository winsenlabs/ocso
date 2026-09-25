import type { ReactNode } from 'react';
import { CtaPair } from './Ctas';
import { FluidBackground } from './FluidBackground';
import { Nav } from './Nav';

export function Hero({ eyebrow, title, children, stats }: { eyebrow: string; title: ReactNode; children?: ReactNode; stats?: [string, string][] }) {
  return (
    <section id="top" className="p-3 md:p-5">
      <div className="on-dark relative isolate overflow-hidden rounded-[2rem] px-4 pb-10 pt-4 md:px-8 md:pt-6">
        <FluidBackground />
        <Nav />
        <div className="relative z-10 mx-auto flex max-w-5xl flex-col items-center pt-16 text-center md:pt-28">
          <p className="mb-9 rounded-full bg-gradient-to-r from-[#8ea4f2]/70 via-white/35 to-[#3d5dcf]/80 p-px shadow-[0_0_40px_-8px_rgba(61,93,207,0.7)]">
            <span className="flex items-center gap-3 rounded-full bg-[#060914]/80 px-4 py-2.5 backdrop-blur-md md:px-6 md:py-3">
              <span className="relative flex size-2.5 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/70 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
              </span>
              <span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.12em] text-white sm:text-xs sm:tracking-[0.2em] md:text-sm">{eyebrow}</span>
            </span>
          </p>
          <h1 className="max-w-5xl text-balance text-[2.75rem] font-medium leading-[1.02] tracking-[-0.035em] text-fg sm:text-5xl md:text-7xl">{title}</h1>
          {children && <div className="mt-7 max-w-3xl font-mono text-[14px] leading-relaxed text-fg/75 md:text-[15px]">{children}</div>}
          <div className="mt-12">
            <CtaPair />
          </div>
        </div>
        {stats && (
          <dl className="relative z-10 mx-auto mt-12 w-fit space-y-2 text-center font-mono text-xs md:mr-6 md:ml-auto md:mt-6 md:text-right md:text-sm">
            {stats.map(([k, v]) => (
              <div key={k}>
                <dt className="inline font-semibold text-fg">{k}</dt> <dd className="inline text-fg/70">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
