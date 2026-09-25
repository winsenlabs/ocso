/**
 * Product screenshots in public/shots. Captured with Playwright, unedited, from a local OCSO stack (built api, worker
 * and web app) running the Meridian Bank demo seed (apps/api/src/seed.ts): a fictional bank, the development-only
 * scripted model and the example MCP server, no real customers. The conversations and proposals in them were made
 * through the product's own UI for the capture. Light theme, 1600×1000 WebP (web chat: 600 wide, portrait).
 */
export type Shot = {
  src: string;
  width: number;
  height: number;
  /** The app path shown in the window frame. */
  path: string;
  caption: string;
  title: string;
  body: string;
  catches: string;
  alt: string;
};

const wide = { width: 1600, height: 1000 } as const;

export const SHOTS = {
  homeHead: {
    ...wide,
    src: '/shots/home-head.webp',
    path: '/',
    caption: 'Home for a Head',
    title: 'What needs you, before it goes wrong',
    body: 'An understaffed queue, an exception to review, the week’s containment and escalations, and the live flow from channel to router to queue to agent.',
    catches: 'A queue with customers waiting and nobody on shift.',
    alt: 'OCSO Home for Anjali, a Head in the Meridian Bank demo, headed “Cards & EMI · Tier 2 is understaffed right now”. It shows an Ask OCSO box with suggested questions, a Needs you list (a bootstrap self-approval exception and the understaffed queue: 2 waiting, 0 of 2 on shift), weekly figures (4 conversations, 25% contained by AI, 75% escalation rate, 0 SLA breaches) and the service flow from the Meridian web chat channel through its router to three queues and the agents Maya and Riya.',
  },
  workspace: {
    ...wide,
    src: '/shots/workspace.webp',
    path: '/conversations',
    caption: 'Workspace',
    title: 'AI and people on the same conversation',
    body: 'The AI agent hands off with a reason, a colleague claims the chat with the AI summary in front of them, and the AI stays attached to take it back.',
    catches: 'A customer stuck with a bot after asking for a person.',
    alt: 'The conversation workspace for Nikhil Menon, a Service member. A web chat customer asked Maya, the AI agent, for a human about a duplicate EMI debit; the timeline shows Maya telling the customer a colleague will join, the escalation, the routing to the Cards & EMI Tier 2 queue, Nikhil claiming it and his reply. A dark banner says Human active: Maya is attached and will not reply until control returns, with Return to AI and Resolve buttons. Side panels show the AI summary, the assignment, the routing and the approved tools.',
  },
  pickup: {
    ...wide,
    src: '/shots/pickup-queue.webp',
    path: '/queues',
    caption: 'Pickup queue',
    title: 'Every hand-off, with its clock running',
    body: 'Conversations waiting for a person in the queues you can work, each with its priority and pickup SLA, and how every queue is routed.',
    catches: 'A hand-off waiting past its pickup time.',
    alt: 'The pickup queue for Nikhil Menon: 4 queues, 3 conversations waiting now, 0 past the pickup SLA. Three web chat customers wait in Cards & EMI · Tier 2 after asking Maya for a human (about a duplicate EMI debit, a hardship plan and a credit card upgrade), each with priority P3 and minutes left to the SLA. Below, the queues table shows each queue’s agent, approval, pickup mode, teams, skills, languages, SLA policy and who is on shift.',
  },
  router: {
    ...wide,
    src: '/shots/router.webp',
    path: '/routers',
    caption: 'Router builder',
    title: 'Routing you can read, test and approve',
    body: 'Build a menu, a model classifier or known-fact rules, then simulate a customer before the router goes live.',
    catches: 'A routing change that sends customers to the wrong queue.',
    alt: 'The router builder for a draft “Meridian menu (example)” router: a menu step asking “Hi! What can we help you with today?” with options for cards, loans and payments, each with synonyms. On the right, a simulation of a customer saying “hi” then “my card was charged twice” shows the router’s reply and its decision: Cards & EMI · Tier 2, agent Maya.',
  },
  agentPrompt: {
    ...wide,
    src: '/shots/agent-prompt.webp',
    path: '/agents',
    caption: 'Agent prompt',
    title: 'Versioned prompts, built from parts',
    body: 'Identity, objective, behaviour and policies compile into one prompt with a hash. Every version is immutable, attributable and can be rolled back.',
    catches: 'A prompt edited in production with no record of who changed it.',
    alt: 'The Prompt tab of Maya, a live customer support agent for cards, EMI and statements. Prompt components (runtime contract, identity, objective, behaviour) are listed in compile order with token counts; the side panel shows live version v2 by Anjali Rao with its hash and reason, and the compiled draft’s token estimate and prompt hash.',
  },
  agentEscalation: {
    ...wide,
    src: '/shots/agent-escalation.webp',
    path: '/agents',
    caption: 'Escalation rules',
    title: 'When the AI must bring in a person',
    body: 'Rules evaluated in code on every turn: hardship language, refunds above a limit, disputes, repeated tool failures, a customer asking for a human.',
    catches: 'An AI agent handling a case it should never handle alone.',
    alt: 'The Escalation tab of the agent Maya with seven active rules evaluated on every turn: hardship or job loss language goes to the Hardship desk, refunds above ₹5,000 and abusive language to Cards & EMI Tier 2, disputes or ombudsman mentions to Disputes, two consecutive tool failures and customers asking for a human, each with a priority and state.',
  },
  channelsSlack: {
    ...wide,
    src: '/shots/channels-slack.webp',
    path: '/connections',
    caption: 'Channel setup',
    title: 'Channels set up from a guide, not a ticket',
    body: 'Each channel type brings its own setup guide. For Slack, OCSO generates the app manifest with this channel’s webhook URL, ready to download.',
    catches: 'A half-configured channel going live: a draft receives nothing until its activation is approved.',
    alt: 'Integrations → Channels with the setup guide for a draft Slack channel, “Meridian Slack (business banking)”. It lists what is still needed (bot token, signing secret), the webhook URL, and step 1, Create the Slack app from the manifest, with Copy and Download buttons for the Slack app manifest in YAML and JSON, then step 2, Review the bot token scopes.',
  },
  queues: {
    ...wide,
    src: '/shots/queues.webp',
    path: '/queues',
    caption: 'Queues',
    title: 'Queues, teams and SLAs in one table',
    body: 'Each queue’s AI agent, pickup mode, eligible teams, skills, languages and SLA policy, all approved changes.',
    catches: 'A queue without an SLA, or with nobody eligible to pick it up.',
    alt: 'The Queues page for Anjali Rao, a Head: 4 queues and 2 conversations waiting. The table shows Cards & EMI Tier 2, Disputes, Hardship desk and Sales callback with their agent, approval state, routing (open pickup or auto-assign), teams, skills and languages, SLA policy, and who is waiting or on shift.',
  },
  homeTech: {
    ...wide,
    src: '/shots/home-tech.webp',
    path: '/',
    caption: 'Home for Tech',
    title: 'The platform, at a glance',
    body: 'Uptime, workers, latency, tokens and connection health, with open incidents first.',
    catches: 'Fewer healthy workers than the configured minimum.',
    alt: 'OCSO Home for Tarun, the Tech admin, headed “1 critical incident is open”: a Healthy workers below minimum alert, a bootstrap self-approval exception, uptime 100%, time to first token 256 ms, model error rate 0%, tokens used today, and capacity (0 of 10 slots used, warm floor 2 workers, ceiling 10).',
  },
  auditLog: {
    ...wide,
    src: '/shots/audit-log.webp',
    path: '/audit',
    caption: 'Audit log',
    title: 'Every privileged action, attributed',
    body: 'Who did what, to which object, through which interface, with payloads redacted when written.',
    catches: 'A change nobody can account for.',
    alt: 'The Audit log for the Tech admin: filters by target type, action, actor, interface and date, and the latest entries, including sign-ins, the verification of the audit chain for entries 1 to 248, and the creation of a draft Slack channel, each with its time, target and actor.',
  },
  approvals: {
    ...wide,
    src: '/shots/approvals.webp',
    path: '/approvals',
    caption: 'Approvals',
    title: 'Every change waits for a second person',
    body: 'The checker sees the maker, the reason, the content hash and the exact before and after, and approves exactly that.',
    catches: 'A settings, prompt or routing change going live without a second look.',
    alt: 'The Approvals page for Rohan Kapoor, a Head, with two queue changes from Anjali Rao awaiting him. One is open in a drawer: “Change queue Cards & EMI · Tier 2”, with its reason (Tamil-speaking customers from the Chennai card launch now reach this queue), maker, checker, content hash and a before and after table (auto-assign after 90 → 120 seconds; languages en, mr, hi → en, mr, hi, ta), and Approve and Reject buttons.',
  },
  exceptions: {
    ...wide,
    src: '/shots/exceptions.webp',
    path: '/exceptions',
    caption: 'Exception report',
    title: 'Where the controls were bypassed, signed weekly',
    body: 'A weekly report of self-approvals, configuration live without an approval and more, frozen with a content hash for a Head to sign.',
    catches: 'Controls that exist on paper but were worked around.',
    alt: 'A weekly exception report for 14–20 September 2026, awaiting signature, with its content hash, a sign-off note and attestation, and its items: configuration live on a migration record only (a notification destination, business and technical alert rules), each explained.',
  },
  auditStore: {
    ...wide,
    src: '/shots/audit-store.webp',
    path: '/system',
    caption: 'Audit store',
    title: 'A separate store you can verify',
    body: 'Events ship to their own append-only database, hash-chained and checkpointed with signatures. Verify any range from the System page.',
    catches: 'An audit trail that was quietly rewritten.',
    alt: 'The audit store panel on the System page: PostgreSQL driver, shipping up to date, chain position 248, a signed checkpoint with its key id, 249 stored events, a daily export and a passed full check, with the result of Verify recent entries: entries 1 to 248 verified against 1 signed checkpoint, no problems.',
  },
  mcp: {
    ...wide,
    src: '/shots/mcp.webp',
    path: '/connections',
    caption: 'MCP connections',
    title: 'Your systems, as governed tools',
    body: 'Shared MCP servers with their auth, scope, tool count and health; tools are approved per agent.',
    catches: 'A tool server that stopped answering.',
    alt: 'Integrations → MCP connections, Shared servers tab: one server, meridian-core (the demo’s core banking system for customers, cards, EMI, statements, disputes and payments), with header authorization, shared scope, 7 of 7 tools and a Healthy status.',
  },
  models: {
    ...wide,
    src: '/shots/models.webp',
    path: '/connections',
    caption: 'Models',
    title: 'Your model providers, your region',
    body: 'Provider cards with residency, caching and profiles; credentials are write-only and stored by reference.',
    catches: 'A model profile that would send customer data out of region.',
    alt: 'Integrations → Models: the scripted demo model (development only) configured in ap-south-1 with its profiles, caching and latency, and cards for AWS Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Anthropic and Sarvam AI, not configured, each listing the credentials and caching it uses.',
  },
} as const satisfies Record<string, Shot>;

/** The gallery in "The OCSO way": how a conversation is routed, answered and handed over. */
export const wayGallery: Shot[] = [SHOTS.homeHead, SHOTS.workspace, SHOTS.router, SHOTS.agentPrompt, SHOTS.agentEscalation, SHOTS.channelsSlack];

/** The governance gallery. */
export const governanceGallery: Shot[] = [SHOTS.exceptions, SHOTS.auditStore, SHOTS.auditLog];

/** One view per team, like Rho's ViewShowcase. */
export const views = [
  { key: 'service', label: 'Service team', shot: SHOTS.pickup, line: 'Claim the next customer from the pickup queue, with the SLA clock and the AI’s summary in front of you.' },
  { key: 'leads', label: 'Leads', shot: SHOTS.queues, line: 'Queues, teams, skills, languages and SLAs: every change goes to a second Head for approval.' },
  { key: 'tech', label: 'Tech', shot: SHOTS.homeTech, line: 'Workers, latency, tokens, providers and incidents, without reading conversation content.' },
  { key: 'auditors', label: 'Auditors', shot: SHOTS.auditLog, line: 'Every privileged action attributed to a person, backed by a hash-chained, signed store.' },
] as const;
