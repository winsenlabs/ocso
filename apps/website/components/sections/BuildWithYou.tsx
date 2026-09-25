import { WINSEN_URL } from '@/content/links';
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
        <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
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
          </div>
          <div className="on-dark flex flex-col items-start gap-4 rounded-2xl bg-[#0b1024] p-6 lg:w-[22rem]">
            <p className="text-sm text-fg/70">Tell us about your customer success team, and we’ll set up a walkthrough.</p>
            <RequestDemo />
            <a href={WINSEN_URL} className="text-sm text-fg/70 hover:text-fg">
              About Winsen Labs <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <p className="font-mono text-sm text-accent">{String(i + 1).padStart(2, '0')}</p>
              <p className="mt-3 text-lg font-medium text-fg">{s.title}</p>
              <p className="mt-2 text-[15px] text-fg/60">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
