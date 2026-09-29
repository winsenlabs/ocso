import { REPO_URL } from '@/content/links';
import { GitHubIcon } from './Ctas';
import { Mark } from './Mark';

/** The top bar: the logo, the thesis, the repository and the demo call to action. Nothing else. */
export function Nav() {
  return (
    <nav aria-label="Main" className="relative z-50 mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-fg/10 bg-black/40 py-2.5 pl-3 pr-2.5 backdrop-blur-xl md:px-5 md:py-3">
      <a href="/" className="flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold tracking-[-0.02em] text-fg">
        <Mark tone="on-dark" />
        <span className="max-[359px]:sr-only">OCSO</span>
      </a>
      <div className="flex items-center gap-3 whitespace-nowrap text-sm text-fg/80 min-[380px]:gap-4 sm:gap-6">
        <a href="/thesis" className="hover:text-fg">
          Our thesis
        </a>
        <a href={REPO_URL} aria-label="GitHub" className="inline-flex items-center gap-1.5 hover:text-fg">
          <GitHubIcon className="size-4 sm:size-3.5" />
          <span className="hidden sm:inline">GitHub</span>
        </a>
        <a href="/#demo" className="rounded-full bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-fg/90 md:px-4">
          <span className="sm:hidden">Demo</span>
          <span className="hidden sm:inline">Request a demo</span>
        </a>
      </div>
    </nav>
  );
}
