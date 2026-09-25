import { REPO_URL, SECTIONS } from '@/content/links';
import { GitHubIcon } from './Ctas';
import { Mark } from './Mark';
import { MobileMenu } from './MobileMenu';

export function Nav() {
  return (
    <nav aria-label="Main" className="relative z-50 mx-auto flex w-full max-w-5xl items-center justify-between rounded-full border border-fg/10 bg-black/40 py-2.5 pl-3 pr-2.5 backdrop-blur-xl md:px-5 md:py-3">
      <a href="#top" className="flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold tracking-[-0.02em] text-fg">
        <Mark tone="on-dark" />
        <span>OCSO</span>
      </a>
      <div className="hidden items-center gap-7 text-sm text-fg/80 md:flex">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="hover:text-fg">
            {s.label}
          </a>
        ))}
        <a href={REPO_URL} className="inline-flex items-center gap-1.5 hover:text-fg">
          <GitHubIcon className="size-3.5" />
          GitHub
        </a>
      </div>
      <div className="flex items-center gap-2">
        <a href="#demo" className="whitespace-nowrap rounded-full bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-fg/90 md:px-4">
          Request a demo
        </a>
        <MobileMenu />
      </div>
    </nav>
  );
}
