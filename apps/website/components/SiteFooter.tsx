import { NAME, REPO_URL, SECTIONS, WINSEN_URL, helloEmail, repo } from '@/content/links';
import { CookieSettings } from './Analytics';
import { AskAi } from './AskAi';
import { ThemedMark } from './Mark';
import { ThemeSwitch } from './ThemeSwitch';

const link = 'mt-2.5 block text-left text-fg/65 transition hover:text-fg';

export function Footer() {
  return (
    <footer className="border-t border-fg/10">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-2 lg:grid-cols-5">
        <div className="sm:col-span-2">
          <a href="/" className="flex items-center gap-2.5 font-semibold tracking-[-0.02em] text-fg">
            <ThemedMark className="size-8" />
            OCSO
          </a>
          <p className="mt-4 text-sm text-fg/55">
            {NAME}.<br /> Open source under the Apache License 2.0, built by Winsen Labs.
          </p>
          <AskAi />
        </div>
        <div className="text-sm">
          <p className="text-fg/40">On this page</p>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`/#${s.id}`} className={link}>
              {s.label}
            </a>
          ))}
          <a href="/thesis" className={link}>
            Our thesis
          </a>
          <a href="/#demo" className={link}>
            Request a demo
          </a>
        </div>
        <div className="text-sm">
          <p className="text-fg/40">Open source</p>
          <a href={REPO_URL} className={link}>
            GitHub
          </a>
          <a href={repo('docs/')} className={link}>
            Documentation
          </a>
          <a href={repo('docs/guides/deploy/docker-compose.md')} className={link}>
            Self-hosting guide
          </a>
          <a href={repo('SECURITY.md')} className={link}>
            Security policy
          </a>
          <a href={repo('LICENSE')} className={link}>
            License
          </a>
        </div>
        <div className="text-sm">
          <p className="text-fg/40">Winsen Labs</p>
          <a href={WINSEN_URL} className={link}>
            winsenlabs.com
          </a>
          <a href={`mailto:${helloEmail}`} className={link}>
            {helloEmail}
          </a>
        </div>
      </div>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 border-t border-fg/10 px-6 py-6 text-xs text-fg/45 sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {new Date().getFullYear()} Winsen Labs. OCSO is pre-1.0: APIs, the schema and plugin contracts can still change.
          <br />
          Analytics (PostHog) and its cookies run only if you accept them; the film loads from YouTube only when you press play. Geist is used under the SIL Open Font License 1.1.
        </p>
        <CookieSettings className="shrink-0 underline decoration-fg/30 underline-offset-4 hover:text-fg" />
        <ThemeSwitch />
      </div>
    </footer>
  );
}
