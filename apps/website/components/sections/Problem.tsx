import { Heading } from '../Heading';

const ROWS: { area: string; today: string; ocso: string }[] = [
  {
    area: 'Channels',
    today: 'A bot on the website, a WhatsApp number run by a vendor, Slack for your biggest accounts. Each with its own rules and its own history.',
    ocso: 'WhatsApp, web chat, Slack and Microsoft Teams behind one contract: one conversation model, one hand-off, one audit trail.',
  },
  {
    area: 'Tools',
    today: 'A helpdesk, a bot builder, a CRM and a spreadsheet of who handles what, stitched together by people.',
    ocso: 'One path for every customer: channel, router, queue, agent. Your own systems join as tools over MCP.',
  },
  {
    area: 'Teams',
    today: 'The bot belongs to one team and the queue to another. At the hand-off, the customer explains everything again.',
    ocso: 'AI agents and people on the same conversation, with explicit control states and the AI summary carried across.',
  },
  {
    area: 'Edge cases',
    today: 'The case nobody configured falls through the cracks, and nobody notices until the customer complains.',
    ocso: 'Escalation rules, SLA policies and a weekly signed report of the customers routing could not place.',
  },
  {
    area: 'AI',
    today: 'Bolted on in places. Prompts edited in production, with no record of who changed what, or why.',
    ocso: 'Versioned prompts, and every change to live configuration approved by a second person and written to a signed audit store.',
  },
];

export function Problem() {
  return (
    <section id="problem" className="mx-auto max-w-6xl scroll-mt-24 px-6 pt-24">
      <Heading
        eyebrow="The problem"
        title="Customer success is scattered."
        lede="Different tools handle different channels, edges and cases, and nobody sees the whole. AI makes it worse when it is bolted on at the edges. We think customer success has to be rethought for the AI age: one layer that orchestrates every channel, agent and person."
      />
      <div className="mt-14 overflow-hidden rounded-3xl border border-fg/10">
        <div className="hidden grid-cols-[10rem_1fr_1fr] border-b border-fg/10 bg-fg/[0.03] font-mono text-xs uppercase tracking-[0.18em] md:grid">
          <p className="px-6 py-4 text-fg/40"> </p>
          <p className="px-6 py-4 text-fg/50">Scattered, today</p>
          <p className="px-6 py-4 text-accent">Orchestrated, with OCSO</p>
        </div>
        {ROWS.map((r) => (
          <div key={r.area} className="grid border-b border-fg/10 last:border-b-0 md:grid-cols-[10rem_1fr_1fr]">
            <p className="px-6 pt-6 text-sm font-medium text-fg md:py-6">{r.area}</p>
            <p className="px-6 pt-3 text-[15px] text-fg/55 md:py-6">
              <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.18em] text-fg/40 md:hidden">Today</span>
              {r.today}
            </p>
            <p className="px-6 pb-6 pt-4 text-[15px] text-fg/85 md:border-l md:border-fg/10 md:bg-accent/[0.04] md:py-6">
              <span className="mb-1 block font-mono text-[11px] uppercase tracking-[0.18em] text-accent md:hidden">With OCSO</span>
              {r.ocso}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
