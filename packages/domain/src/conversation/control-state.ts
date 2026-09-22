/**
 * Conversation control state — who is driving the conversation.
 * See docs/03 §3 and ADR-005.
 */
export const ControlState = {
  AI_ACTIVE: 'AI_ACTIVE',
  ESCALATION_REQUESTED: 'ESCALATION_REQUESTED',
  WAITING_FOR_HUMAN: 'WAITING_FOR_HUMAN',
  HUMAN_ACTIVE: 'HUMAN_ACTIVE',
  AI_RESUMING: 'AI_RESUMING',
  RESOLVED: 'RESOLVED',
} as const;
export type ControlState = (typeof ControlState)[keyof typeof ControlState];

export const CONTROL_STATES: readonly ControlState[] = Object.values(ControlState);

/** Coarse projection from docs/03 §2 (`control_mode`). Derived, never stored. */
export type ControlMode = 'AI' | 'WAITING_HUMAN' | 'HUMAN' | 'RESOLVED';

export function controlModeOf(state: ControlState): ControlMode {
  switch (state) {
    case ControlState.AI_ACTIVE:
    case ControlState.AI_RESUMING:
      return 'AI';
    case ControlState.ESCALATION_REQUESTED:
    case ControlState.WAITING_FOR_HUMAN:
      return 'WAITING_HUMAN';
    case ControlState.HUMAN_ACTIVE:
      return 'HUMAN';
    case ControlState.RESOLVED:
      return 'RESOLVED';
  }
}

/**
 * The only state in which the virtual agent may send autonomous
 * customer-facing output. Checked by the runtime before generation and
 * again by the worker immediately before any customer-visible write.
 */
export function aiMaySendAutonomously(state: ControlState): boolean {
  return state === ControlState.AI_ACTIVE;
}

/** States in which an inbound customer message should start an AI turn. */
export function inboundStartsAiTurn(state: ControlState): boolean {
  return (
    state === ControlState.AI_ACTIVE ||
    state === ControlState.AI_RESUMING ||
    state === ControlState.RESOLVED
  );
}

/** States where a human currently owns or is expected to own the conversation. */
export function isHumanOwned(state: ControlState): boolean {
  return state === ControlState.HUMAN_ACTIVE;
}

export function isOpen(state: ControlState): boolean {
  return state !== ControlState.RESOLVED;
}
