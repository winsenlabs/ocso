/**
 * Product screenshots in public/shots. Captured with Playwright from a local OCSO stack (built api, worker and web
 * app) running the Meridian Bank demo seed (apps/api/src/seed.ts): a fictional bank, the development-only scripted
 * model, no real customers. ask-ocso.webp is the drawer cropped from a full-page capture; its question bubble was edited to plain words: the scripted model needs a
 * test directive in the question to produce a card; the card itself is the server's. `src: null` renders a plain panel instead of an invented UI.
 */
export interface ShotInfo {
  readonly src: string | null;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** The app path shown in the window frame. */
  readonly path: string;
}

export type ShotId = 'home' | 'workspace' | 'askOcso' | 'approvals';

export const SHOTS: Readonly<Record<ShotId, ShotInfo>> = {
  home: {
    src: '/shots/home.webp',
    width: 2400,
    height: 1500,
    path: '/',
    alt: 'OCSO Home for Anjali Rao, a Head in the demo: an alert that the Cards & EMI Tier 2 queue is understaffed, a list of items that need her, headline figures for the day, and the service flow from the web chat channel through its router to the queues and the agents Maya and Riya.',
  },
  workspace: {
    src: '/shots/workspace.webp',
    width: 2400,
    height: 1500,
    path: '/conversations',
    alt: 'The conversation workspace for Nikhil Menon, a Service member: a web chat that the AI agent Maya escalated to the Cards & EMI Tier 2 queue, where Nikhil claimed it and replied about a duplicate EMI debit. Side panels show the AI summary, the assignment and the routing.',
  },
  askOcso: {
    src: '/shots/ask-ocso.webp',
    width: 732,
    height: 1180,
    path: 'Ask OCSO',
    alt: 'The Ask OCSO drawer, showing a Confirm change card to approve a colleague’s proposed change to the web chat channel settings, with the field that will change, a warning that the user is deciding someone else’s change, and Confirm change and Cancel buttons.',
  },
  approvals: {
    src: '/shots/approvals.webp',
    width: 2400,
    height: 1500,
    path: '/approvals',
    alt: 'The approvals page with three proposals from Tarun Shetty awaiting Anjali Rao. One is open beside the list: a worker settings change with its reason, content hash, a before and after diff, and Approve and Reject buttons.',
  },
};
