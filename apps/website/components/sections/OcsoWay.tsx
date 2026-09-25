import { Heading } from '../Heading';
import { ShotGallery } from '../ShotGallery';
import { AskOcso } from './AskOcso';

// The example path is the Meridian Bank demo's (a fictional bank): web chat → router → Cards & EMI → Maya.
const STAGES = [
  { title: 'Channels', chips: ['WhatsApp', 'Web chat', 'Slack', 'Teams'], lit: 'Web chat', body: 'Each message is verified and stored before anything else happens.' },
  { title: 'Routers', chips: ['Menu', 'Model', 'Known facts'], lit: 'Model', body: 'Ask a menu question, classify with a model, or use what you already know, then pick a queue.' },
  { title: 'Queues', chips: ['Cards & EMI', 'Hardship', 'Sales'], lit: 'Cards & EMI', body: 'The service unit: one AI agent, its human teams, an SLA policy, hours and transfer targets.' },
  { title: 'Agents and people', chips: ['Maya, AI agent', 'Your team'], lit: 'Maya, AI agent', body: 'The AI answers with the tools you approved. A rule, the customer or the agent can bring in a person.' },
];

const STATES = ['AI active', 'Escalation requested', 'Waiting for a human', 'Human active', 'AI resuming', 'Resolved'];

const TEAMS = [
  { role: 'Head', title: 'For customer success leaders', body: 'Full authority inside your teams: agents, queues, SLAs and quality. You check your colleagues’ changes and sign the exception report.' },
  { role: 'Lead', title: 'For team leads', body: 'Run your teams’ agents, prompts, queues and routers. Propose changes, replay a draft prompt on past conversations, and roll back.' },
  { role: 'Service', title: 'For service teams', body: 'Handle the conversations in your queues. Take over from the AI with the context in front of you, then hand back.' },
  { role: 'Tech', title: 'For platform teams', body: 'Run the platform: model providers, channels, MCP, sign-in and audit verification, without reading conversation content.' },
];

export function OcsoWay() {
  return (
    <section id="the-ocso-way" className="mx-auto max-w-6xl scroll-mt-24 px-6 pt-24">
      <Heading
        eyebrow="The OCSO way"
        title="One orchestration layer for customer success."
        lede="Every customer takes the same readable path, whichever channel they write on. AI agents and your people work the same conversations, and hand them to each other in both directions."
      />

      <ol className="mt-14 grid gap-3 md:grid-cols-4">
        {STAGES.map((s, i) => (
          <li key={s.title} className="relative rounded-2xl border border-fg/10 bg-fg/[0.02] p-5">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">
              {String(i + 1).padStart(2, '0')} · {s.title}
            </p>
            <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={`${s.title} examples`}>
              {s.chips.map((c) => (
                <li key={c} className={`rounded-full border px-2.5 py-1 text-xs ${c === s.lit ? 'border-accent bg-accent/15 text-fg' : 'border-fg/12 text-fg/55'}`}>
                  {c}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-fg/65">{s.body}</p>
            {i < STAGES.length - 1 && (
              <span aria-hidden className="absolute -right-3 top-1/2 z-10 hidden size-6 -translate-y-1/2 place-items-center rounded-full border border-fg/15 bg-bg text-xs text-fg/60 md:grid">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-fg/10 p-5 md:flex-row md:items-center md:justify-between">
        <p className="text-sm text-fg/70">
          <span className="font-medium text-fg">Hand-off both ways.</span> Every change of control is explicit and audited:
        </p>
        <ol className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-fg/60" aria-label="Conversation control states">
          {STATES.map((s, i) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className="rounded-md bg-fg/[0.05] px-2 py-1">{s}</span>
              {i < STATES.length - 1 && <span aria-hidden className="text-fg/30">→</span>}
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-16">
        <ShotGallery />
      </div>

      <div className="mt-24">
        <Heading title="Built for everyone in customer success." lede="Four role presets, checked in code, with per-user grants on top. Each team sees what it owns." />
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {TEAMS.map((t) => (
            <div key={t.role} className="flex flex-col rounded-3xl border border-fg/10 p-7 transition hover:border-accent/50 hover:bg-accent/[0.06]">
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">{t.role}</p>
              <p className="mt-4 text-xl font-medium text-fg">{t.title}</p>
              <p className="mt-3 flex-1 text-[15px] text-fg/60">{t.body}</p>
            </div>
          ))}
        </div>
      </div>

      <AskOcso />
    </section>
  );
}
