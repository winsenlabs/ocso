/**
 * In-app approval notices (PM/research/11b): the maker hears the outcome of
 * their change, the checker hears that something waits for them. Pure.
 */
export interface ApprovalDecidedEvent {
  proposalId: string;
  objectKind: string;
  decision: string;
  checkerId: string | null;
  makerId: string | null;
}

export interface ApprovalRequestedEvent {
  proposalId: string;
  makerId: string;
  checkerId: string;
}

export interface ApprovalNotice {
  id: string;
  tone: 'good' | 'warn' | 'error';
  text: string;
  href: string;
}

const DECIDED: Readonly<Record<string, { tone: ApprovalNotice['tone']; text: string }>> = {
  APPROVED: { tone: 'good', text: 'Your change was approved and is now in effect.' },
  REJECTED: { tone: 'error', text: 'Your change was rejected — see the reason, fix it and submit again.' },
  BLOCKED: { tone: 'error', text: 'Your approved change no longer passed validation, so nothing changed.' },
  VOID: { tone: 'warn', text: 'Your change was voided: its object no longer exists.' },
};

const href = (id: string) => `/approvals?box=sent&approval=${encodeURIComponent(id)}`;

export function decidedNotice(eventId: string, e: ApprovalDecidedEvent, meId: string): ApprovalNotice | null {
  if (e.makerId !== meId || e.checkerId === meId) return null;
  const known = DECIDED[e.decision];
  return known ? { id: eventId, tone: known.tone, text: known.text, href: href(e.proposalId) } : null;
}

/** "3 changes are waiting for you" — counted across events. */
export function requestedNotice(e: ApprovalRequestedEvent, meId: string, waiting: number): ApprovalNotice | null {
  if (e.checkerId !== meId || e.makerId === meId) return null;
  return {
    id: 'approval-waiting',
    tone: 'warn',
    text: waiting === 1 ? 'A change is waiting for your approval.' : `${waiting} changes are waiting for your approval.`,
    href: '/approvals',
  };
}
