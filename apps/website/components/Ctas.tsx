import { REPO_URL } from '@/content/links';

const arrow = (
  <svg aria-hidden viewBox="0 0 16 16" className="size-4 transition-transform duration-300 group-hover:translate-x-0.5">
    <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function GitHubIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

/** "Request a demo": scrolls to the form. There is no self-serve demo. */
export function RequestDemo({ label = 'Request a demo' }: { label?: string }) {
  return (
    <a
      href="#demo"
      className="group inline-flex items-center gap-2.5 rounded-full bg-white py-3.5 pl-6 pr-5 font-medium text-[#05070d] shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_8px_30px_-6px_rgba(61,93,207,0.7)] transition duration-300 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.6),0_10px_40px_-4px_rgba(61,93,207,0.95)]"
    >
      {label}
      <span className="grid size-6 place-items-center rounded-full bg-[#05070d] text-white">{arrow}</span>
    </a>
  );
}

export function ViewOnGitHub({
  className = 'inline-flex items-center gap-2.5 rounded-full border border-white/25 bg-white/[0.06] px-6 py-3.5 font-medium text-white backdrop-blur-md transition duration-300 hover:border-white/45 hover:bg-white/[0.12]',
}: {
  className?: string;
}) {
  return (
    <a href={REPO_URL} className={className}>
      <GitHubIcon />
      View on GitHub
    </a>
  );
}

/** The only two actions on the site. */
export function CtaPair() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <RequestDemo />
      <ViewOnGitHub />
    </div>
  );
}
