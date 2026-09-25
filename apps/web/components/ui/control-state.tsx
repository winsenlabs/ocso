import type { ReactNode } from 'react';
import type { ControlState as DomainControlState } from '@ocso/domain';

/** Visual control states (.cstate): who is driving the conversation. */
export type ControlStateKind = 'ai' | 'wait' | 'human' | 'returning' | 'resolved' | 'routing';

export const CONTROL_STATE_LABELS: Readonly<Record<ControlStateKind, string>> = {
  ai: 'AI active',
  wait: 'Waiting for human',
  human: 'Human active',
  returning: 'Returning to AI',
  resolved: 'Resolved',
  // A router is asking the customer which queue they need (PM/research/11 §5).
  routing: 'Routing',
};

/** Domain control state (docs/archive/specs/03 §3) → chip. Escalation requested shows as waiting. */
export function controlStateKind(state: DomainControlState): ControlStateKind {
  switch (state) {
    case 'AI_ACTIVE':
      return 'ai';
    // A router is asking the customer: automation drives, no agent yet (PM/research/11 §5).
    case 'ROUTING':
      return 'routing';
    case 'ESCALATION_REQUESTED':
    case 'WAITING_FOR_HUMAN':
      return 'wait';
    case 'HUMAN_ACTIVE':
      return 'human';
    case 'AI_RESUMING':
      return 'returning';
    case 'RESOLVED':
      return 'resolved';
  }
}

export function ControlState({ state, children }: { state: ControlStateKind; children?: ReactNode }) {
  return (
    <span className={`cstate ${state}`}>
      <span className="dot" aria-hidden="true" />
      {children ?? CONTROL_STATE_LABELS[state]}
    </span>
  );
}
