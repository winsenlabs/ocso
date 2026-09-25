/* eslint-disable @next/next/no-img-element -- pre-sized WebP, served as is. */
import { WINSEN_URL } from '@/content/links';
import { SHOTS } from '@/content/shots';
import { RequestDemo } from '../Ctas';

const STEPS = [
  { title: 'Map how you serve customers today', body: 'Your channels, queues, teams, tools and the edge cases that fall between them.' },
  { title: 'Stand up OCSO on your infrastructure', body: 'Your servers or your cloud account, your model providers, your systems connected over MCP.' },
  { title: 'Run it with your team', body: 'Agents, routing and hand-offs shaped with the people who serve your customers, every change approved.' },
];

/** First section after the hero: Winsen Labs builds this with a small number of teams. */
export function BuildWithYou() {
  return (
    <section id="build-with-you" className="mx-auto max-w-6xl scroll-mt-24 px-6 pt-16 md:pt-20">
      <div className="relative overflow-hidden rounded-[2rem] border border-fg/10 bg-gradient-to-b from-accent/[0.09] via-transparent to-transparent p-6 md:p-10">
        <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Built with Winsen Labs</p>
            <h2 className="mt-4 max-w-2xl text-4xl font-medium tracking-[-0.03em] text-fg md:text-5xl">We’ll build this with you.</h2>
            <p className="mt-5 max-w-2xl text-lg text-fg/60">
              OCSO is open source, and you can run it yourself. If you would rather rethink customer success with the people who build it,{' '}
              <a href={WINSEN_URL} className="text-fg underline decoration-accent decoration-2 underline-offset-4 hover:decoration-fg">
                Winsen Labs
              </a>{' '}
              works alongside a small number of teams at a time. We select those engagements carefully, so each one gets our full attention.
            </p>
            <ol className="mt-12 grid gap-8">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-5">
                  <p className="font-mono text-sm text-accent">{String(i + 1).padStart(2, '0')}</p>
                  <div>
                    <p className="text-lg font-medium text-fg">{s.title}</p>
                    <p className="mt-2 max-w-xl text-[15px] text-fg/60">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="on-dark mt-12 flex flex-col items-start gap-4 rounded-2xl bg-[#0b1024] p-6 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-xs text-sm text-fg/70">Tell us about your customer success team, and we’ll set up a walkthrough.</p>
              <div className="flex flex-col items-start gap-3">
                <RequestDemo />
                <a href={WINSEN_URL} className="text-sm text-fg/70 hover:text-fg">
                  About Winsen Labs <span aria-hidden>→</span>
                </a>
              </div>
            </div>
          </div>
          <figure className="w-full">
            <div className="overflow-hidden rounded-2xl border border-fg/10 bg-white shadow-[0_30px_80px_-30px_rgba(61,93,207,0.55)]">
              <img src={SHOTS.workspace.src} alt={SHOTS.workspace.alt} width={SHOTS.workspace.width} height={SHOTS.workspace.height} loading="lazy" decoding="async" className="block h-auto w-full" />
            </div>
            <figcaption className="mt-3 text-center text-xs text-fg/50">Your team&rsquo;s view: the AI hands over, a named colleague picks up the same conversation with the AI&rsquo;s summary. Demo data.</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
