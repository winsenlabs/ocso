/**
 * Product screenshots in public/shots, captured with Playwright from a local OCSO stack (built api, worker and web
 * app) running the Meridian Bank demo seed (apps/api/src/seed.ts): a fictional bank, the development-only scripted
 * model, no real customers. Unedited. Light theme only.
 */
export type Shot = {
  src: string;
  /** The app path shown in the window frame. */
  path: string;
  caption: string;
  title: string;
  body: string;
  catches: string;
  alt: string;
};

export const shots: Shot[] = [
  {
    src: '/shots/home.webp',
    path: '/',
    caption: 'Home',
    title: 'Every agent and queue, on one page',
    body: 'What needs you, how the AI agents did this week, and the live service flow from channel to router to queue to agent.',
    catches: 'Approvals and exceptions waiting on you, before they go stale.',
    alt: 'OCSO Home for Anjali, a Head in the Meridian Bank demo: an Ask OCSO box with suggested questions, a Needs you list of approvals and a bootstrap self-approval exception, weekly figures (5 conversations, 80% contained by AI, 20% escalation rate, 0 SLA breaches) and the service flow from the Meridian web chat channel through its router to three queues and the agents Maya and Riya.',
  },
  {
    src: '/shots/workspace.webp',
    path: '/conversations',
    caption: 'Workspace',
    title: 'AI and people on the same conversation',
    body: 'The AI agent escalates with a reason, a colleague claims the chat, and the AI stays attached, ready to take it back.',
    catches: 'A customer stuck with a bot when they asked for a person.',
    alt: 'The conversation workspace for Nikhil Menon, a Service member: a web chat where the AI agent Maya requested a handoff because the customer asked for a human, the chat was routed to the Cards & EMI Tier 2 queue, and Nikhil claimed it and replied about a duplicate EMI debit. Side panels show the AI summary, the assignment and the routing.',
  },
  {
    src: '/shots/approvals.webp',
    path: '/approvals',
    caption: 'Approvals',
    title: 'Every change waits for a second person',
    body: 'Each proposal shows its maker, its reason, its content hash and exactly what would change, before anything goes live.',
    catches: 'A settings, prompt or routing change going live without a second look.',
    alt: 'The approvals page with three proposals from Tarun Shetty awaiting Anjali Rao. One is open beside the list: a workers settings change with its reason, content hash, a before and after table, and Approve and Reject buttons.',
  },
];
