import { ControlState } from './control-state.js';
import { DomainError } from '../errors/domain-error.js';

/** Commands that move a conversation between control states (ADR-005). */
export const ControlCommand = {
  REQUEST_ESCALATION: 'REQUEST_ESCALATION',
  ROUTE_TO_QUEUE: 'ROUTE_TO_QUEUE',
  CLAIM: 'CLAIM',
  ACCEPT_ASSIGNMENT: 'ACCEPT_ASSIGNMENT',
  TAKE_OVER: 'TAKE_OVER',
  RELEASE_TO_QUEUE: 'RELEASE_TO_QUEUE',
  RETURN_TO_AI: 'RETURN_TO_AI',
  CANCEL_RETURN: 'CANCEL_RETURN',
  RESUME_AI: 'RESUME_AI',
  CANCEL_ESCALATION: 'CANCEL_ESCALATION',
  RESOLVE: 'RESOLVE',
  REOPEN: 'REOPEN',
  /** Routing (PM/research/11 §5.5): a router starts asking (new conversation or a returning customer). */
  ROUTE_START: 'ROUTE_START',
  /** The router chose a queue and its agent. */
  ROUTE_COMPLETE: 'ROUTE_COMPLETE',
  /** The returning customer continues: back to the state before routing (a resolved one reopens). */
  ROUTE_CONTINUE: 'ROUTE_CONTINUE',
  /** Move to another queue (and its agent) keeping the control state. */
  TRANSFER_QUEUE: 'TRANSFER_QUEUE',
} as const;
export type ControlCommand = (typeof ControlCommand)[keyof typeof ControlCommand];

export type TransitionActor = 'AGENT' | 'HUMAN' | 'SYSTEM' | 'CUSTOMER';

export interface TransitionContext {
  actor: TransitionActor;
  /** Human user performing the command, when actor is HUMAN. */
  actorUserId?: string | undefined;
  /** Currently assigned user on the conversation, if any. */
  assignedUserId?: string | null | undefined;
  /** For REOPEN: who reopens decides the target state. */
  reopenedBy?: 'CUSTOMER' | 'HUMAN' | undefined;
  /** For ROUTE_CONTINUE: the state the conversation had before routing started. */
  restoreState?: ControlState | null | undefined;
}

interface TransitionRule {
  from: readonly ControlState[];
  actors: readonly TransitionActor[];
  to: (ctx: TransitionContext, from: ControlState) => ControlState;
  guard?: (ctx: TransitionContext, from: ControlState) => string | null;
}

const S = ControlState;
const OPEN_STATES = [
  S.AI_ACTIVE,
  S.ESCALATION_REQUESTED,
  S.WAITING_FOR_HUMAN,
  S.HUMAN_ACTIVE,
  S.AI_RESUMING,
] as const;

const requireHumanUser = (ctx: TransitionContext): string | null =>
  ctx.actorUserId ? null : 'a human command requires an acting user';

/** Explicit transition table. Anything not listed is rejected. */
export const TRANSITIONS: Readonly<Record<ControlCommand, TransitionRule>> = {
  REQUEST_ESCALATION: {
    from: [S.AI_ACTIVE, S.AI_RESUMING],
    actors: ['AGENT', 'SYSTEM', 'HUMAN'],
    to: () => S.ESCALATION_REQUESTED,
  },
  ROUTE_TO_QUEUE: {
    from: [S.ESCALATION_REQUESTED],
    actors: ['SYSTEM'],
    to: () => S.WAITING_FOR_HUMAN,
  },
  CLAIM: {
    from: [S.WAITING_FOR_HUMAN],
    actors: ['HUMAN'],
    to: () => S.HUMAN_ACTIVE,
    guard: (ctx) =>
      requireHumanUser(ctx) ??
      (ctx.assignedUserId && ctx.assignedUserId !== ctx.actorUserId
        ? 'conversation is assigned to another user'
        : null),
  },
  ACCEPT_ASSIGNMENT: {
    from: [S.WAITING_FOR_HUMAN],
    actors: ['HUMAN'],
    to: () => S.HUMAN_ACTIVE,
    guard: (ctx) =>
      requireHumanUser(ctx) ??
      (ctx.assignedUserId === ctx.actorUserId ? null : 'only the assigned user can accept'),
  },
  TAKE_OVER: {
    from: [S.AI_ACTIVE, S.AI_RESUMING, S.ESCALATION_REQUESTED],
    actors: ['HUMAN'],
    to: () => S.HUMAN_ACTIVE,
    guard: requireHumanUser,
  },
  RELEASE_TO_QUEUE: {
    from: [S.HUMAN_ACTIVE],
    actors: ['HUMAN', 'SYSTEM'],
    to: () => S.WAITING_FOR_HUMAN,
  },
  RETURN_TO_AI: {
    from: [S.HUMAN_ACTIVE],
    actors: ['HUMAN'],
    to: () => S.AI_RESUMING,
    guard: requireHumanUser,
  },
  CANCEL_RETURN: {
    from: [S.AI_RESUMING],
    actors: ['HUMAN'],
    to: () => S.HUMAN_ACTIVE,
    guard: requireHumanUser,
  },
  RESUME_AI: {
    from: [S.AI_RESUMING],
    actors: ['SYSTEM'],
    to: () => S.AI_ACTIVE,
  },
  CANCEL_ESCALATION: {
    from: [S.ESCALATION_REQUESTED, S.WAITING_FOR_HUMAN],
    actors: ['HUMAN', 'SYSTEM'],
    to: () => S.AI_ACTIVE,
  },
  RESOLVE: {
    from: [...OPEN_STATES, S.ROUTING],
    actors: ['HUMAN', 'AGENT', 'SYSTEM'],
    to: () => S.RESOLVED,
  },
  REOPEN: {
    from: [S.RESOLVED],
    actors: ['CUSTOMER', 'HUMAN', 'SYSTEM'],
    to: (ctx) => (ctx.reopenedBy === 'HUMAN' ? S.HUMAN_ACTIVE : S.AI_ACTIVE),
    guard: (ctx) =>
      ctx.reopenedBy === 'HUMAN' ? requireHumanUser(ctx) : null,
  },
  ROUTE_START: {
    from: [S.AI_ACTIVE, S.RESOLVED],
    actors: ['SYSTEM'],
    to: () => S.ROUTING,
  },
  ROUTE_COMPLETE: {
    from: [S.ROUTING],
    actors: ['SYSTEM'],
    to: () => S.AI_ACTIVE,
  },
  ROUTE_CONTINUE: {
    from: [S.ROUTING],
    actors: ['SYSTEM'],
    // Only AI states are ever left for routing; a resolved conversation reopens to the AI.
    to: (ctx) => (ctx.restoreState === S.AI_RESUMING ? S.AI_RESUMING : S.AI_ACTIVE),
  },
  TRANSFER_QUEUE: {
    from: [S.AI_ACTIVE, S.WAITING_FOR_HUMAN, S.HUMAN_ACTIVE],
    actors: ['AGENT', 'HUMAN'],
    to: (_ctx, from) => from,
    guard: (ctx, from) =>
      ctx.actor === 'AGENT'
        ? from === S.AI_ACTIVE
          ? null
          : 'the AI transfers only while it is active'
        : from === S.AI_ACTIVE
          ? 'a human transfers a conversation they or their queue hold'
          : requireHumanUser(ctx),
  },
};

export class InvalidTransitionError extends DomainError {
  constructor(
    readonly from: ControlState,
    readonly command: ControlCommand,
    reason: string,
  ) {
    super('conflict', 'invalid_control_transition', `${command} not allowed from ${from}: ${reason}`);
  }
}

/** Pure transition function. Throws InvalidTransitionError when not allowed. */
export function transition(
  from: ControlState,
  command: ControlCommand,
  ctx: TransitionContext,
): ControlState {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(from)) {
    throw new InvalidTransitionError(from, command, 'source state not permitted');
  }
  if (!rule.actors.includes(ctx.actor)) {
    throw new InvalidTransitionError(from, command, `actor ${ctx.actor} not permitted`);
  }
  const guardFailure = rule.guard?.(ctx, from) ?? null;
  if (guardFailure) {
    throw new InvalidTransitionError(from, command, guardFailure);
  }
  return rule.to(ctx, from);
}

export function canTransition(
  from: ControlState,
  command: ControlCommand,
  ctx: TransitionContext,
): boolean {
  try {
    transition(from, command, ctx);
    return true;
  } catch {
    return false;
  }
}
