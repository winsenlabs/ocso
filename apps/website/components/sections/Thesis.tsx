
const TODAY: { title: string; body: string }[] = [
  {
    title: 'Scattered is how it feels from the outside.',
    body: 'Customers never see your org chart. They see one company, and then they are asked to tell their story again on every channel, to every team, after every transfer. Each seam in your stack is a moment where a customer has to start over.',
  },
  {
    title: 'The bot and the call centre know different things.',
    body: 'The chatbot knows the help centre. The agent on the phone knows the account, the history and the notes. Neither knows what the other was told. When the bot gets stuck it sends the customer to a phone queue, where they wait, prove who they are again and start from the top. Neither side can easily bring the customer back in to send a document or confirm a detail in the chat they already have open.',
  },
  {
    title: 'A bad chatbot is a bad customer experience.',
    body: 'Customers do not rate your bot on its own. They rate you. A bot that loops, cannot hand over, or answers confidently and wrongly does not save a conversation. It spends your customer’s patience, and then their trust.',
  },
];

const BELIEFS: { title: string; body: string }[] = [
  {
    title: 'One conversation, on the channel the customer chose',
    body: 'WhatsApp, web chat, Slack or Teams: the same conversation, the same history and the same hand-off. Nobody asks the customer to start again.',
  },
  {
    title: 'AI agents and people are one team',
    body: 'They see the same customer, use the same approved tools and write to the same record. The AI hands over with a summary, a colleague picks up where it stopped, and hands back when they are done.',
  },
  {
    title: 'AI earns trust in the open',
    body: 'An AI agent acts only through the tools you approved for it. A rule, the customer or the agent itself can bring in a person. Every change to how it behaves is approved by a second person and written to a signed audit trail.',
  },
  {
    title: 'Everything that touches the outside world is a plugin',
    body: 'Channels, models, tools and alerts plug into a small core through published contracts. You choose your vendors, and you can change them without relearning how you serve customers.',
  },
];

const PLUGINS: { group: string; items: string[] }[] = [
  {
    group: 'Channels',
    items: ['WhatsApp (Meta)', 'WhatsApp (Twilio)', 'Web chat', 'Slack', 'Microsoft Teams'],
  },
  {
    group: 'Models',
    items: ['AWS Bedrock', 'Google Vertex AI', 'Microsoft Foundry', 'OpenAI', 'Anthropic', 'Sarvam'],
  },
  { group: 'Tools', items: ['Any MCP server', 'Your own systems'] },
  {
    group: 'Alerts',
    items: ['In-app', 'Email', 'Slack', 'Teams', 'Webhook', 'PagerDuty'],
  },
  { group: 'Email', items: ['Resend', 'SMTP'] },
  {
    group: 'Infrastructure',
    items: ['Postgres or SQS queues', 'Local or S3 files', 'Postgres or ClickHouse audit'],
  },
];

const CORE = ['Conversations', 'Routing', 'AI–human hand-off', 'Approvals', 'Signed audit'];

function PluginGroup({ group, items }: { group: string; items: string[] }) {
  return (
    <div className="min-w-0 rounded-2xl border border-fg/10 bg-bg p-5">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">{group}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={`${group} plugins`}>
        {items.map((i) => (
          <li key={i} className="rounded-full border border-fg/12 px-2.5 py-1 text-xs text-fg/70">
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The thesis, below its page hero: what customers live with, what we believe, the plugin core and the close. */
export function ThesisBody() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-8">
      <p className="mt-16 font-mono text-xs uppercase tracking-[0.2em] text-fg/45">What customers live with today</p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {TODAY.map((t) => (
          <article key={t.title} className="min-w-0 rounded-3xl border border-fg/10 p-7">
            <h3 className="text-lg font-medium text-fg">{t.title}</h3>
            <p className="mt-3 text-[15px] leading-relaxed text-fg/60">{t.body}</p>
          </article>
        ))}
      </div>

      <p className="mt-16 font-mono text-xs uppercase tracking-[0.2em] text-fg/45">What we believe</p>
      <ol className="mt-5 grid gap-x-10 gap-y-8 md:grid-cols-2">
        {BELIEFS.map((b, i) => (
          <li key={b.title} className="flex min-w-0 gap-4 border-t border-fg/10 pt-6">
            <span className="font-mono text-sm text-accent">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <h3 className="text-xl font-medium tracking-[-0.01em] text-fg">{b.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-fg/60">{b.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-16 rounded-3xl border border-fg/10 bg-fg/[0.02] p-6 md:p-9">
        <div className="max-w-3xl">
          <h3 className="text-2xl font-medium tracking-[-0.02em] text-fg md:text-3xl">Customer service, built from plugins.</h3>
          <p className="mt-3 text-[15px] leading-relaxed text-fg/60 md:text-base">
            OCSO is a small core that owns what must never vary: the conversation, routing, the hand-off between AI and people, approvals and the
            audit trail. Everything that touches an outside system plugs in through a published contract, and a lint rule fails the build if core code
            ever names one. Change your WhatsApp provider, your model or your paging tool, and the way you serve customers stays the same.
          </p>
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)] lg:items-center">
          <div className="grid gap-3 max-lg:contents">
            {PLUGINS.slice(0, 3).map((p) => (
              <PluginGroup key={p.group} {...p} />
            ))}
          </div>
          <div className="on-dark order-first rounded-3xl bg-[#0b1024] p-7 text-center sm:col-span-2 lg:order-none lg:col-span-1">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-fg/50">The OCSO core</p>
            <ul className="mt-5 grid gap-2" aria-label="What the core owns">
              {CORE.map((c) => (
                <li key={c} className="rounded-xl border border-fg/15 px-3 py-2.5 text-sm text-fg/90">
                  {c}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs leading-relaxed text-fg/55">Plugins meet the core through versioned contracts, never the other way round.</p>
          </div>
          <div className="grid gap-3 max-lg:contents">
            {PLUGINS.slice(3).map((p) => (
              <PluginGroup key={p.group} {...p} />
            ))}
          </div>
        </div>
      </div>

      <figure className="mx-auto mt-16 max-w-4xl text-center">
        <blockquote className="text-balance text-xl font-medium leading-snug tracking-[-0.02em] text-fg sm:text-2xl md:text-[2rem]">
          “We did not start from a helpdesk or a chatbot and add AI. We started from the customer, and asked what serving them well looks like when
          part of your team is AI. The answer had to be open: your channels, your models, your systems, your rules.”
        </blockquote>
        <figcaption className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-fg/45">Winsen Labs, the team behind OCSO</figcaption>
      </figure>
    </section>
  );
}
