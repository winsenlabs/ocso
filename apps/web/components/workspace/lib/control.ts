import { Permission } from '@ocso/auth';
import type { ControlState } from '@ocso/domain';

/**
 * Which human operations the workspace offers for a conversation, from its
 * control state (ADR-005 transition table), who holds it and the viewer's
 * permissions. The API re-checks everything; this only decides what to show.
 */

export type WorkspaceAction =
  | 'claim'
  | 'accept'
  | 'decline'
  | 'take-over'
  | 'transfer'
  | 'return-to-ai'
  | 'cancel-return'
  | 'resolve'
  | 'reopen';

export interface ControlContext {
  controlState: ControlState;
  assignedUserId: string | null;
  /** Open handoff status (OFFERED means an auto-assign offer awaits the assignee). */
  handoffStatus: string | null;
  meId: string;
  permissions: ReadonlySet<string>;
}

export interface ControlView {
  actions: WorkspaceAction[];
  /** The viewer may write to the customer and use the composer. */
  canCompose: boolean;
  /** The viewer is the assigned human (vs. a lead acting with assign rights). */
  holdsIt: boolean;
  /** Offered to the viewer by auto-assign and not yet accepted. */
  offeredToMe: boolean;
}

export function controlView(ctx: ControlContext): ControlView {
  const has = (p: string) => ctx.permissions.has(p);
  const mine = ctx.assignedUserId !== null && ctx.assignedUserId === ctx.meId;
  const handler = mine || has(Permission.CONVERSATIONS_ASSIGN);
  const actions: WorkspaceAction[] = [];
  let offeredToMe = false;

  switch (ctx.controlState) {
    case 'AI_ACTIVE':
    case 'ESCALATION_REQUESTED':
      if (has(Permission.CONVERSATIONS_TAKE_OVER)) actions.push('take-over');
      break;
    case 'WAITING_FOR_HUMAN':
      if (mine && ctx.handoffStatus === 'OFFERED') {
        offeredToMe = true;
        if (has(Permission.CONVERSATIONS_CLAIM)) actions.push('accept', 'decline');
      } else if (ctx.assignedUserId === null && has(Permission.CONVERSATIONS_CLAIM)) {
        actions.push('claim');
      } else if (mine && has(Permission.CONVERSATIONS_CLAIM)) {
        actions.push('claim');
      }
      break;
    case 'HUMAN_ACTIVE':
      if (handler) {
        if (has(Permission.CONVERSATIONS_RETURN_TO_AI)) actions.push('return-to-ai');
        if (has(Permission.CONVERSATIONS_TRANSFER)) actions.push('transfer');
        if (has(Permission.CONVERSATIONS_RESOLVE)) actions.push('resolve');
      }
      break;
    case 'AI_RESUMING':
      if (handler && has(Permission.CONVERSATIONS_RETURN_TO_AI)) actions.push('cancel-return');
      if (has(Permission.CONVERSATIONS_TAKE_OVER) && !handler) actions.push('take-over');
      break;
    case 'RESOLVED':
      if (has(Permission.CONVERSATIONS_TAKE_OVER)) actions.push('reopen');
      break;
  }
  const canCompose = ctx.controlState === 'HUMAN_ACTIVE' && handler && has(Permission.CONVERSATIONS_REPLY);
  return { actions, canCompose, holdsIt: mine, offeredToMe };
}

export const ACTION_LABELS: Readonly<Record<WorkspaceAction, string>> = {
  claim: 'Claim conversation',
  accept: 'Accept',
  decline: 'Decline',
  'take-over': 'Take over',
  transfer: 'Transfer',
  'return-to-ai': 'Return to AI',
  'cancel-return': 'Cancel return',
  resolve: 'Resolve',
  reopen: 'Reopen',
};
