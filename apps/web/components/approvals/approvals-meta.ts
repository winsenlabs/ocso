/**
 * The /approvals URL model (PM/research/11b "ui"). Pure and client-safe: tab,
 * filters, cursor and the open drawer live in the URL.
 */
export type ApprovalBox = 'AWAITING_ME' | 'SENT_BY_ME' | 'OPEN' | 'DECIDED';

export interface ApprovalsParams {
  box?: ApprovalBox | undefined;
  /** Registered object kind filter chip, e.g. `agent`. */
  kind?: string | undefined;
  /** "Needs a new checker" chip (All open). */
  needsChecker?: boolean | undefined;
  /** Open drawer. */
  approval?: string | undefined;
  before?: string | undefined;
  beforeId?: string | undefined;
}

export const BOX_LABELS: Record<ApprovalBox, string> = {
  AWAITING_ME: 'Awaiting me',
  SENT_BY_ME: 'Sent by me',
  OPEN: 'All open',
  DECIDED: 'Decided',
};

const BOX_SLUGS: Record<ApprovalBox, string> = { AWAITING_ME: 'awaiting', SENT_BY_ME: 'sent', OPEN: 'open', DECIDED: 'decided' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = /^[a-z][a-z0-9_]{0,59}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v ? v : undefined;
}

/** Parse search params into a safe model: unknown values are dropped, ids must be UUIDs. */
export function parseApprovalsParams(raw: Record<string, string | string[] | undefined>): ApprovalsParams {
  const slug = first(raw['box']);
  const box = (Object.keys(BOX_SLUGS) as ApprovalBox[]).find((b) => BOX_SLUGS[b] === slug);
  const kind = first(raw['kind']);
  const approval = first(raw['approval']);
  const before = first(raw['before']);
  const beforeId = first(raw['beforeId']);
  const cursor = before && ISO.test(before) && beforeId && UUID.test(beforeId);
  return {
    box: box ?? 'AWAITING_ME',
    kind: kind && KIND.test(kind) ? kind : undefined,
    needsChecker: first(raw['needs']) === 'checker' ? true : undefined,
    approval: approval && UUID.test(approval) ? approval : undefined,
    before: cursor ? before : undefined,
    beforeId: cursor ? beforeId : undefined,
  };
}

/** Build an /approvals URL; defaults (Awaiting me, no filter) are left out. */
export function approvalsHref(p: ApprovalsParams): string {
  const q = new URLSearchParams();
  if (p.box && p.box !== 'AWAITING_ME') q.set('box', BOX_SLUGS[p.box]);
  if (p.kind) q.set('kind', p.kind);
  if (p.needsChecker) q.set('needs', 'checker');
  if (p.before && p.beforeId) {
    q.set('before', p.before);
    q.set('beforeId', p.beforeId);
  }
  if (p.approval) q.set('approval', p.approval);
  const qs = q.toString();
  return qs ? `/approvals?${qs}` : '/approvals';
}

/** The API query for the list (the drawer id is not part of it). */
export function toApiQuery(p: ApprovalsParams) {
  return { box: p.box ?? 'AWAITING_ME', objectKind: p.kind, needsChecker: p.needsChecker, before: p.before, beforeId: p.beforeId, limit: 50 } as const;
}
