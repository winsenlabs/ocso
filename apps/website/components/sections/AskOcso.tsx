import { repo } from '@/content/links';

const POINTS = [
  { title: 'It acts as you, never as more', body: 'Every call goes through the real API with a single-use delegation for you: the same permissions, team scope, approvals and audit as the app.' },
  { title: 'Every write is a card you confirm', body: 'Reads answer straight away. A write comes back as a confirmation card built by the server, and runs only when you click.' },
  { title: 'Governed changes go to a checker', body: 'A change that needs approval becomes a proposal, and the checker can review and decide it from Ask OCSO too.' },
  { title: 'Also in Slack and Microsoft Teams', body: 'Link your chat account once and ask as yourself, with the same cards, approvals and audit.' },
];

const QUESTIONS = ['What needs my attention?', 'What is waiting on my approval?', 'Which conversations are waiting for a human?', 'Which agent escalates most this week?'];

const PILLARS = [
  { href: '#governance', label: 'Governed by default', body: 'Maker–checker approvals, a separate signed audit store and a weekly exception report.' },
  { href: '#open-source', label: 'Built to extend', body: 'Channels, models and alerts are plugins. Your systems connect as MCP tools.' },
  { href: '#self-host', label: 'Yours to host', body: 'Apache-2.0. Docker Compose on your own server, or Terraform for AWS.' },
];

/** Ask OCSO, then the three pillars the next sections expand on. */
export function AskOcso() {
  return (
    <>
      <div className="mt-24 grid gap-10 rounded-[2rem] border border-fg/10 p-6 md:p-10 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Ask OCSO · ⌘J</p>
          <h3 className="mt-4 text-3xl font-medium tracking-[-0.02em] text-fg md:text-4xl">A copilot that can do anything you are permitted to do.</h3>
          <p className="mt-4 text-lg text-fg/60">Its tools are generated from OCSO’s own API and filtered to your permissions, so it grows with the product.</p>
          <ul className="mt-8 space-y-2" aria-label="Example questions">
            {QUESTIONS.map((q) => (
              <li key={q} className="w-fit rounded-2xl rounded-bl-md border border-fg/10 bg-fg/[0.03] px-4 py-2 text-[15px] text-fg/80">
                {q}
              </li>
            ))}
          </ul>
          <a href={repo('docs/guides/channels/ask-ocso-in-slack-and-teams.md')} className="mt-8 inline-block text-sm text-accent hover:underline">
            Ask OCSO in Slack and Teams →
          </a>
        </div>
        <ul className="grid gap-6 self-center">
          {POINTS.map((p, i) => (
            <li key={p.title} className="flex gap-4">
              <span className="font-mono text-sm text-accent">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <p className="font-medium text-fg">{p.title}</p>
                <p className="mt-1 text-[15px] text-fg/60">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {PILLARS.map((p) => (
          <a key={p.href} href={p.href} className="group rounded-3xl border border-fg/10 p-7 transition hover:border-accent/50 hover:bg-accent/[0.06]">
            <p className="text-lg font-medium text-fg">{p.label}</p>
            <p className="mt-2 text-[15px] text-fg/60">{p.body}</p>
            <p className="mt-5 text-sm text-fg/60 group-hover:text-fg">
              Read more <span className="inline-block transition group-hover:translate-x-1">→</span>
            </p>
          </a>
        ))}
      </div>
    </>
  );
}
