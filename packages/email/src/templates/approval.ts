import type { RenderedEmail } from '../contract.js';
import { oneLine } from './escape.js';
import { renderLayout, type EmailBlock } from './layout.js';

/**
 * Maker–checker notifications (PM/research/11 §4): a checker is asked to
 * decide, a maker learns the outcome, a Tech admin learns a checker can no
 * longer act. Plain facts and a deep link; never the change's payload.
 */
export type ApprovalEmailKind = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'BLOCKED' | 'WITHDRAWN' | 'VOID' | 'CHECKER_INVALID';

export interface ApprovalEmailInput {
  org: string;
  kind: ApprovalEmailKind;
  /** Proposal title, e.g. "Take Maya live". */
  title: string;
  /** "Virtual agent". */
  objectLabel: string;
  makerName: string;
  checkerName: string | null;
  /** The maker's reason (REQUESTED) or the checker's (decided). */
  reason: string | null;
  /** Changed fields in plain words, e.g. "name, business hours". */
  changes?: string | null | undefined;
  link?: string | null | undefined;
  reference?: string | null | undefined;
}

const SUBJECT: Record<ApprovalEmailKind, string> = {
  REQUESTED: 'Approval needed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  BLOCKED: 'Blocked at activation',
  WITHDRAWN: 'Withdrawn',
  VOID: 'Voided',
  CHECKER_INVALID: 'Needs a new checker',
};

function lead(input: ApprovalEmailInput): string {
  const maker = oneLine(input.makerName, 80);
  const checker = input.checkerName ? oneLine(input.checkerName, 80) : 'The checker';
  switch (input.kind) {
    case 'REQUESTED':
      return `${maker} asked you to approve a change. Nothing changes until you decide.`;
    case 'APPROVED':
      return `${checker} approved your change. It is now in effect.`;
    case 'REJECTED':
      return `${checker} rejected your change. The object is unchanged; you can fix it and submit again.`;
    case 'BLOCKED':
      return 'Your approved change no longer passed validation when it was applied, so nothing changed. Fix it and submit again.';
    case 'WITHDRAWN':
      return `${maker} withdrew this change.`;
    case 'VOID':
      return 'The object this change was for no longer exists, so the proposal was voided.';
    case 'CHECKER_INVALID':
      return `${checker} can no longer approve this change (disabled, or no longer holds the approval permission). Someone with reassignment rights must name a new checker.`;
  }
}

export function approvalEmail(input: ApprovalEmailInput): RenderedEmail {
  const title = oneLine(input.title, 160);
  const blocks: EmailBlock[] = [{ kind: 'text', text: lead(input) }];
  const facts: Array<readonly [string, string]> = [
    ['Change', title],
    ['Object', oneLine(input.objectLabel, 80)],
    ['Maker', oneLine(input.makerName, 80)],
  ];
  if (input.checkerName) facts.push(['Checker', oneLine(input.checkerName, 80)]);
  if (input.changes) facts.push(['Fields', oneLine(input.changes, 200)]);
  if (input.reason) facts.push([input.kind === 'REQUESTED' ? 'Reason' : 'Note', input.reason.slice(0, 500)]);
  blocks.push({ kind: 'facts', rows: facts });
  if (input.link) blocks.push({ kind: 'button', label: 'Open in OCSO', url: input.link });
  if (input.reference) blocks.push({ kind: 'note', text: input.reference });
  return renderLayout({
    org: input.org,
    subject: `[OCSO] ${SUBJECT[input.kind]}: ${title}`,
    heading: `${SUBJECT[input.kind]}: ${title}`,
    preheader: lead(input),
    blocks,
  });
}
