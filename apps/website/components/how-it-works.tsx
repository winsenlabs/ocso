import { Section } from './section';
import { Shot } from './shot';

interface Stage {
  readonly n: string;
  readonly title: string;
  readonly chips: readonly { label: string; lit?: boolean }[];
  readonly body: string;
}

// The example path is the Meridian Bank demo's (a fictional bank): web chat → router → Cards & EMI → Maya.
const STAGES: readonly Stage[] = [
  {
    n: '01',
    title: 'Channel',
    chips: [{ label: 'WhatsApp' }, { label: 'Web chat', lit: true }, { label: 'Slack' }, { label: 'Teams' }],
    body: 'The message is verified and committed to PostgreSQL before anything else happens. Queue messages are only wake-ups.',
  },
  {
    n: '02',
    title: 'Router',
    chips: [{ label: 'Menu' }, { label: 'Model', lit: true }, { label: 'Known facts' }],
    body: 'Asks a menu question, classifies with a model or uses what it already knows about the customer, then picks a queue.',
  },
  {
    n: '03',
    title: 'Queue',
    chips: [{ label: 'Cards & EMI', lit: true }, { label: 'Hardship' }, { label: 'Sales' }],
    body: 'The service unit: one AI agent, its human teams, an SLA policy, opening hours and transfer targets.',
  },
  {
    n: '04',
    title: 'Agent',
    chips: [{ label: 'Maya, AI agent', lit: true }, { label: 'Your team' }],
    body: 'The AI agent answers with the tools you approved. When a rule, the customer or the agent asks for a person, your team takes over.',
  },
];

const STATES = ['AI active', 'Escalation requested', 'Waiting for a human', 'Human active', 'AI resuming', 'Resolved'] as const;

/** The Route mark, drawn out: four channels converge on a router, which splits to queues; the chosen path is lit. */
function RouteLine() {
  const inputs = [30, 70, 110, 150];
  const queues = [40, 90, 140];
  return (
    <svg className="route-svg" viewBox="0 0 1000 180" preserveAspectRatio="xMinYMid meet" aria-hidden="true" focusable="false">
      {inputs.map((y) => (
        <path key={`in-${y}`} className={y === 70 ? 'lit' : 'dim'} d={`M8 ${y}C150 ${y} 140 90 262 90`} />
      ))}
      {queues.map((y) => (
        <path key={`q-${y}`} className={y === 40 ? 'lit' : 'dim'} d={`M262 90C390 90 380 ${y} 512 ${y}`} />
      ))}
      <path className="lit" d="M512 40H752" />
      <path className="handoff" d="M512 40C640 40 630 140 752 140" />
      <path className="pulse" d="M8 70C150 70 140 90 262 90C390 90 380 40 512 40H752" pathLength={1000} />
      {inputs.map((y) => (
        <circle key={`d-${y}`} cx="8" cy={y} r="6" className={y === 70 ? 'dot-ink' : 'dot-dim'} />
      ))}
      <circle cx="262" cy="90" r="11" className="node" />
      {queues.map((y) => (
        <circle key={`qd-${y}`} cx="512" cy={y} r="7" className={y === 40 ? 'dot-ink' : 'dot-dim'} />
      ))}
      <circle cx="760" cy="40" r="11" className="dot-accent" />
      <circle cx="760" cy="140" r="8" className="dot-dim" />
    </svg>
  );
}

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      index="02"
      eyebrow="How it works"
      title="Channel, router, queue, agent. The same path every time."
      intro="A customer never lands on an agent by accident. The route is configuration you can read, approve and audit, and the AI stays attached while a person handles the conversation."
      tone="tint"
    >
      <div className="route">
        <RouteLine />
        <ol className="route-stages">
          {STAGES.map((s) => (
            <li key={s.n} className="route-stage">
              <p className="route-n">{s.n}</p>
              <h3>{s.title}</h3>
              <ul className="chips" aria-label={`${s.title} examples`}>
                {s.chips.map((c) => (
                  <li key={c.label} className={c.lit ? 'chip chip-lit' : 'chip'}>
                    {c.label}
                  </li>
                ))}
              </ul>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="handoff-block">
        <div className="handoff-copy">
          <h3>Human handoff with explicit states</h3>
          <p>
            Escalation rules, auto-assign or open pickup, transfers, internal notes and copilot reply drafts. Every
            change of control is audited, and the agent can pick the conversation up again when your colleague hands it
            back.
          </p>
          <ol className="states" aria-label="Conversation control states">
            {STATES.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
        <Shot id="workspace" caption="Maya escalated this chat to a queue; a colleague claimed it and is now handling it." />
      </div>
    </Section>
  );
}
